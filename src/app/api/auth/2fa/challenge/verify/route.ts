import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { verifyAndConsumeTotp } from '@/lib/auth/totp';
import {
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  RECOVERY_CODE_LOW_THRESHOLD,
} from '@/lib/auth/recovery-codes';
import { markSessionTotpVerified } from '@/lib/auth/session';
import { getRequestClientIp } from '@/lib/auth/session';
import { totpChallengeSchema } from '@/lib/validate/totp';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { isFirstSessionFromDevice, notifyNewDeviceLogin } from '@/lib/auth/notifications';
import { findUserById } from '@/lib/db/queries/users';

const TOTP_CODE_PATTERN = /^\d{6}$/;

/**
 * POST /api/auth/2fa/challenge/verify — 保留セッションを昇格させる（§8.4）。
 *
 * - `denyTotpPending: false` でパイプラインの封じ込めを解除する（この API が昇格そのもの）。
 * - 6 桁の数字は TOTP、それ以外はリカバリーコードとして扱う。**どちらの失敗も `INVALID_CODE` に統一**する。
 * - 昇格時（初回のログイン成功）に `login_success` と新規デバイス通知を記録する（D-33-07 / T14）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, denyTotpPending: false },
    async ({ user, session, body }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      // 既に昇格済みのセッションでの二重送信は検知して 400 にする（冪等にしない）。
      if (!session.totpPending) {
        return failResponse('VALIDATION_ERROR', '既に 2 段階認証は完了しています', 400);
      }

      const { code } = totpChallengeSchema.parse(body);

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

      let method: 'totp' | 'recovery_code';
      if (TOTP_CODE_PATTERN.test(code)) {
        const result = await verifyAndConsumeTotp({ userId: user.id, code });
        if (!result.ok) {
          await rateLimiter.finishFailedAttempt(reservation.reservation, false);
          await recordSecurityEvent('login_failed', user.id, ip, userAgent, { scope: '2fa' });
          return failResponse('INVALID_CODE', '認証コードが正しくありません', 400);
        }
        method = 'totp';
      } else {
        const consumed = await consumeRecoveryCode(user.id, code);
        if (!consumed) {
          await rateLimiter.finishFailedAttempt(reservation.reservation, false);
          await recordSecurityEvent('login_failed', user.id, ip, userAgent, { scope: '2fa' });
          return failResponse('INVALID_CODE', '認証コードが正しくありません', 400);
        }
        method = 'recovery_code';
      }
      await rateLimiter.finishFailedAttempt(reservation.reservation, true);

      await markSessionTotpVerified(session.id);
      await recordSecurityEvent('login_success', user.id, ip, userAgent, { method });

      // 新規デバイス通知は 2FA 完了後に初めて送る（保留段階では送らない・§8.7）。
      try {
        const isNewDevice = await isFirstSessionFromDevice(
          user.id,
          session.id,
          session.ipHash,
          session.deviceName,
        );
        if (isNewDevice) {
          const fullUser = await findUserById(user.id);
          if (fullUser) {
            await notifyNewDeviceLogin({
              userId: user.id,
              userEmail: fullUser.email,
              deviceName: session.deviceName,
              ipMasked: session.ipMasked,
              ipCountry: null,
              occurredAt: new Date(),
              ip,
              userAgent,
            });
          }
        }
      } catch {
        // 通知判定の失敗でも昇格は成功として扱う
      }

      const remaining = method === 'recovery_code' ? await countUnusedRecoveryCodes(user.id) : undefined;
      return handleSuccess({
        verified: true,
        method,
        ...(remaining === undefined
          ? {}
          : { recovery_codes_remaining: remaining, low: remaining < RECOVERY_CODE_LOW_THRESHOLD }),
      });
    },
  );
}
