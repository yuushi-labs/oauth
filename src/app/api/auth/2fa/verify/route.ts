import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { verifyAndConsumeTotp } from '@/lib/auth/totp';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/auth/recovery-codes';
import { enableTotpWithRecoveryCodes } from '@/lib/db/queries/totp';
import { totpVerifySchema } from '@/lib/validate/totp';
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
 * POST /api/auth/2fa/verify — コードを検証して 2FA を有効化する。
 *
 * 有効化（`enabled=true`）とリカバリーコード 10 個の保存は**同一トランザクション**で行う（§8.3）。
 * 平文コードを返すのはこの 1 回のみ。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, body }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const { code } = totpVerifySchema.parse(body);

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

    // 有効化前は `enabled = false` の保留行を検証する（BUG: enabled=true 条件で常に失敗していた）。
    const result = await verifyAndConsumeTotp({ userId: user.id, code, allowPending: true });
    if (!result.ok) {
      await rateLimiter.finishFailedAttempt(reservation.reservation, false);
      await recordSecurityEvent('login_failed', user.id, ip, userAgent, { scope: '2fa' });
      return failResponse('INVALID_CODE', '認証コードが正しくありません', 400);
    }
    await rateLimiter.finishFailedAttempt(reservation.reservation, true);

    const codes = generateRecoveryCodes();
    await enableTotpWithRecoveryCodes(user.id, codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c))));

    await recordSecurityEvent('2fa_enabled', user.id, ip, userAgent);

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

    return handleSuccess({ enabled: true, recovery_codes: codes });
  });
}
