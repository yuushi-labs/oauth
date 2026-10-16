import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertEmailVerificationToken, invalidateEmailVerificationTokens } from '@/lib/db/queries/tokens';
import { findUserById } from '@/lib/db/queries/users';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendVerificationEmail } from '@/lib/auth/email/templates';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import { recordSecurityEvent } from '@/lib/auth/security-events';

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user, body: requestBody }) => {
      if (!user) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      const fullUser = await findUserById(user.id);
      if (!fullUser) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      if (fullUser.emailVerified) {
        return failResponse('VALIDATION_ERROR', 'email は既に認証されています', 400);
      }

      const ip = getRequestClientIp(request);
      const captchaToken = typeof requestBody === 'object' && requestBody !== null &&
        'captchaToken' in requestBody && typeof requestBody.captchaToken === 'string'
        ? requestBody.captchaToken
        : null;
      const rl1 = await rateLimiter.check(
        rateLimitKeys.resendUser(user.id),
        RATE_LIMITS.resend.user.window,
        RATE_LIMITS.resend.user.limit,
        RATE_LIMITS.resend.user.softLimit,
      );
      if (!rl1.allowed) {
        if (rl1.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, request.headers.get('user-agent') ?? '', { scope: 'resend_user' });
        return rateLimitResponse(rl1.resetAt);
      }
      const rl2 = await rateLimiter.check(
        rateLimitKeys.resendIp(ip),
        RATE_LIMITS.resend.ip.window,
        RATE_LIMITS.resend.ip.limit,
        RATE_LIMITS.resend.ip.softLimit,
      );
      if (!rl2.allowed) {
        if (rl2.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, request.headers.get('user-agent') ?? '', { scope: 'resend_ip' });
        return rateLimitResponse(rl2.resetAt);
      }
      try {
        await verifyCaptchaIfRequired(rl1.captchaRequired || rl2.captchaRequired, captchaToken, ip);
      } catch (error) {
        if (error instanceof ApiError) return failResponse(error.code, error.message, error.status);
        throw error;
      }
      if (rl1.captchaRequired || rl2.captchaRequired) await recordSecurityEvent('captcha_challenged', user.id, ip, request.headers.get('user-agent') ?? '', { scope: 'resend_verification' });

      await invalidateEmailVerificationTokens(user.id);

      const { raw, hash, id } = generateToken();
      const tokenTTL = 30 * 60 * 1000;
      await insertEmailVerificationToken({
        id,
        userId: user.id,
        tokenHash: hash,
        purpose: 'email_verification',
        expiresAt: new Date(Date.now() + tokenTTL),
      });

      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/verify-email?token=${raw}`;
      await sendVerificationEmail(fullUser.email, url);

      return handleSuccess({ message: '確認-email を再送信しました' });
    },
  );
}
