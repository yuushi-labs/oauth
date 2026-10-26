import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { requireStrongReauth } from '@/lib/auth/strong-reauth';
import { deleteTotp } from '@/lib/db/queries/totp';
import { deleteAllRecoveryCodes } from '@/lib/auth/recovery-codes';
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
 * POST /api/auth/2fa/disable — 2FA を無効化する（強い再認証必須・D-33-14）。
 *
 * 順序: `requireStrongReauth`（パスワード再認証 ＋ 現在のコード）→ 成功したら削除。
 * **検証に失敗したら何も変更しない**（T23）。コードの消費は検証の一部なので戻さない。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session, body }) => {
    if (!user || !session) {
      return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    }

    // Passkey 再認証も受け付けるため、body をそのまま強い再認証へ渡す（D-34-11）。
    const parsed = passkeyDeleteSchema.parse(body);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const reservation = await rateLimiter.reserveFailedAttempt(
      rateLimitKeys.twoFactorUser(user.id),
      RATE_LIMITS.twoFactor.window,
      RATE_LIMITS.twoFactor.limit,
      RATE_LIMITS.twoFactor.softLimit,
    );
    if (!reservation.allowed) {
      await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: '2fa' });
      return rateLimitResponse(reservation.resetAt);
    }

    // 失敗（REAUTH_REQUIRED / INVALID_CODE）はそのまま呼び出し元へ伝播させる。
    await requireStrongReauth({ user, session, body: parsed });
    await rateLimiter.finishFailedAttempt(reservation.reservation, true);

    await deleteTotp(user.id);
    await deleteAllRecoveryCodes(user.id);
    await recordSecurityEvent('2fa_disabled', user.id, ip, userAgent);

    const fullUser = await findUserById(user.id);
    if (fullUser) {
      await deliverEmailSafely({
        kind: 'change_notification',
        userId: user.id,
        ip,
        userAgent,
        send: () =>
          sendChangeNotificationEmail(fullUser.email, {
            change: m('security.twoFactor'),
            time: new Date().toISOString(),
            ip,
          }),
      });
    }

    return handleSuccess({ enabled: false });
  });
}
