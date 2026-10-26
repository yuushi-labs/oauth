import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { requireStrongReauth } from '@/lib/auth/strong-reauth';
import { countCredentialsByUser, deleteCredential, findCredentialByIdForUser } from '@/lib/db/queries/webauthn';
import { findTotpByUserId } from '@/lib/db/queries/totp';
import { passkeyDeleteSchema } from '@/lib/validate/passkey';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { findUserById } from '@/lib/db/queries/users';
import { m } from '@/messages/ja';

/**
 * DELETE /api/auth/passkey/{id} — Passkey を削除する（§8.6）。
 *
 * **強い再認証必須**（パスワード＋コード、または Passkey）。最後のログイン手段の削除は 409。
 * 存在しない / 他人の credential は同じ 404 にまとめる（§49）。
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session, body }) => {
    if (!user || !session) {
      return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    }

    const { id } = await context.params;
    const parsed = passkeyDeleteSchema.parse(body);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const rl = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!rl.allowed) {
      if (rl.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'passkey' });
      return rateLimitResponse(rl.resetAt);
    }

    // 強い再認証（パスワード＋コード、または Passkey）。
    await requireStrongReauth({ user, session, body: parsed });

    // owner 確認（存在しない / 他人は同じ 404 に丸める・§49）。
    const credential = await findCredentialByIdForUser(id, user.id);
    if (!credential) {
      return failResponse('INVALID_TOKEN', 'パスキーが見つかりません', 404);
    }

    // 最後のログイン手段の削除を拒否する（パスワード無し・Passkey 1 件・TOTP 無効）。
    const totpRow = await findTotpByUserId(user.id);
    const remaining = await countCredentialsByUser(user.id);
    if (!user.passwordHash && remaining <= 1 && !totpRow?.enabled) {
      return failResponse(
        'LAST_LOGIN_METHOD',
        '最後のログイン手段は削除できません。先にパスワードまたは 2 段階認証を設定してください',
        409,
      );
    }

    const deleted = await deleteCredential(id, user.id);
    if (!deleted) {
      return failResponse('INVALID_TOKEN', 'パスキーが見つかりません', 404);
    }

    await recordSecurityEvent('passkey_removed', user.id, ip, userAgent, {
      device_name: credential.deviceName,
    });

    const fullUser = await findUserById(user.id);
    if (fullUser) {
      await deliverEmailSafely({
        kind: 'passkey_change',
        userId: user.id,
        ip,
        userAgent,
        send: () =>
          sendChangeNotificationEmail(fullUser.email, {
            change: m('passkey.title'),
            time: new Date().toISOString(),
            ip,
          }),
      });
    }

    return handleSuccess({ message: 'パスキーを削除しました' });
  });
}
