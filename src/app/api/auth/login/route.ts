import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { setSessionCookie, setAnonCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import type { FailedAttemptReservation } from '@/lib/auth/rate-limit';
import { findUserByEmailOrUsername } from '@/lib/db/queries/users';
import { z } from 'zod';

const loginSchema = z.object({
  email_or_username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { email_or_username, password } = loginSchema.parse(body);

      const ip = getRequestClientIp(request);
      const rl1 = await rateLimiter.check(
        rateLimitKeys.loginIp(ip),
        RATE_LIMITS.login.ip.window,
        RATE_LIMITS.login.ip.limit,
        RATE_LIMITS.login.ip.softLimit,
      );
      if (!rl1.allowed) {
        if (rl1.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', { scope: 'login_ip' });
        return rateLimitResponse(rl1.resetAt);
      }

      const reservations: FailedAttemptReservation[] = [];
      for (const [key, limit] of [
        [rateLimitKeys.loginAccount(email_or_username), RATE_LIMITS.login.account],
        [rateLimitKeys.loginIpAccount(ip, email_or_username), RATE_LIMITS.login.ipAccount],
      ] as const) {
        const result = await rateLimiter.reserveFailedAttempt(key, limit.window, limit.limit, limit.softLimit);
        if (!result.allowed) {
          await Promise.all(reservations.map((reservation) => rateLimiter.releaseReservation(reservation).catch(() => undefined)));
          return rateLimitResponse(result.resetAt);
        }
        reservations.push(result.reservation);
      }

      try {
        await verifyCaptchaIfRequired(reservations.some((reservation) => reservation.captchaRequired),
          typeof body === 'object' && body && 'captchaToken' in body && typeof body.captchaToken === 'string' ? body.captchaToken : null, ip);
      } catch (error) {
        await Promise.all(reservations.map((reservation) => rateLimiter.releaseReservation(reservation).catch(() => undefined)));
        if (error instanceof ApiError) return failResponse(error.code, error.message, error.status);
        throw error;
      }
      if (reservations.some((reservation) => reservation.captchaRequired)) {
        await recordSecurityEvent('captcha_challenged', null, ip, request.headers.get('user-agent') ?? '', { scope: 'login' });
      }

      const user = await findUserByEmailOrUsername(email_or_username);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const valid = await Promise.race([
        user ? verifyPassword(password, user.passwordHash ?? '') : Promise.resolve(false),
        new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error('AUTH_TIMEOUT')), 5_000); }),
      ]).finally(() => { if (timeoutId) clearTimeout(timeoutId); }).catch(async (error: unknown) => {
        if (error instanceof Error && error.message === 'AUTH_TIMEOUT') {
          await Promise.all(reservations.map((reservation) => rateLimiter.releaseReservation(reservation).catch(() => undefined)));
          return null;
        }
        throw error;
      });
      if (valid === null) return failResponse('INTERNAL_ERROR', '認証処理がタイムアウトしました', 504);

      if (!user || !valid) {
        const reachedLimit = await Promise.all(reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, false)));
        if (reachedLimit.some(Boolean)) await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', { scope: 'login_failed_attempt' });
        await recordSecurityEvent('login_failed', null, ip, request.headers.get('user-agent') ?? '');
        return failResponse('INVALID_CREDENTIALS', '認証情報が正しくありません', 401);
      }

      await Promise.all(reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, true)));

      if (user.status === 'suspended') {
        await recordSecurityEvent('login_failed', user.id, ip, request.headers.get('user-agent') ?? '');
        return failResponse('ACCOUNT_SUSPENDED', 'このアカウントは利用できません', 403);
      }

      const { token, session } = await createSession(user.id, request);
      await setSessionCookie(token);
      await setAnonCookie(session.csrfSecret);

      await recordSecurityEvent('login_success', user.id, ip, request.headers.get('user-agent') ?? '');

      return handleSuccess({ message: 'ログインしました' });
    },
  );
}
