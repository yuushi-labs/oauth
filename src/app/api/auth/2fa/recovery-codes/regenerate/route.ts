import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { requireStrongReauth } from '@/lib/auth/strong-reauth';
import {
  generateRecoveryCodes,
  saveRecoveryCodes,
  deleteAllRecoveryCodes,
} from '@/lib/auth/recovery-codes';
import { totpDisableSchema } from '@/lib/validate/totp';
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
 * POST /api/auth/2fa/recovery-codes/regenerate — リカバリーコードを再生成する（§8.6）。
 *
 * 強い再認証必須。既存を全削除してから新しい 10 個を保存する（古いコードを無効化する）。
 * **TOTP は有効のまま**（無効化はしない）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session, body }) => {
    if (!user || !session) {
      return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    }

    const { code } = totpDisableSchema.parse(body);

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

    await requireStrongReauth({ user, session, code });
    await rateLimiter.finishFailedAttempt(reservation.reservation, true);

    const codes = generateRecoveryCodes();
    await deleteAllRecoveryCodes(user.id);
    await saveRecoveryCodes(user.id, codes);

    await recordSecurityEvent('2fa_enabled', user.id, ip, userAgent, { reason: 'regenerated' });

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

    return handleSuccess({ recovery_codes: codes });
  });
}
