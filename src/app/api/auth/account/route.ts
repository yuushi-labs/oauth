import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { requireStrongReauth } from '@/lib/auth/strong-reauth';
import { passkeyDeleteSchema } from '@/lib/validate/passkey';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { performAccountDeletion } from '@/lib/auth/account-deletion';

/**
 * DELETE /api/auth/account — 2FA または Passkey で本人確認してアカウントを削除する（§8 / §24）。
 *
 * 確認手段は「2FA（パスワード＋現在のコード／リカバリーコード）」または「Passkey assertion」。
 * どちらも無い利用者はメール確認（`POST /api/auth/account/delete/request` → メール内リンク）を使う。
 * パスワードの 5 分猶予だけでは削除できない（`requireStrongReauth` が code / passkey を要求する）。
 *
 * 検証に失敗したら**何も変更しない**。成功時は `performAccountDeletion` に副作用を集約する。
 */
export async function DELETE(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session, body }) => {
    if (!user || !session) {
      return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    }

    const parsed = passkeyDeleteSchema.parse(body);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const reservation = await rateLimiter.reserveFailedAttempt(
      rateLimitKeys.accountDeleteUser(user.id),
      RATE_LIMITS.accountDelete.window,
      RATE_LIMITS.accountDelete.limit,
      RATE_LIMITS.accountDelete.softLimit,
    );
    if (!reservation.allowed) {
      await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'account_delete' });
      return rateLimitResponse(reservation.resetAt);
    }

    // 失敗（REAUTH_REQUIRED / INVALID_CODE）はそのまま呼び出し元へ伝播させる。
    const { method } = await requireStrongReauth({ user, session, body: parsed });
    await rateLimiter.finishFailedAttempt(reservation.reservation, true);

    await performAccountDeletion({ userId: user.id, ip, userAgent, metadata: { method } });

    return handleSuccess({ message: 'アカウントを削除しました' });
  });
}
