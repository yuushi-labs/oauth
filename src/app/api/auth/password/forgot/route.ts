import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertPasswordResetToken, invalidatePasswordResetTokens } from '@/lib/db/queries/tokens';
import { findUserByLowerEmail } from '@/lib/db/queries/users';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendPasswordResetEmail } from '@/lib/auth/email/templates';
import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import { recordSecurityEvent } from '@/lib/auth/security-events';

const forgotSchema = z.object({
  email: emailSchema,
  captchaToken: z.string().optional(),
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { email, captchaToken } = forgotSchema.parse(body);

      const ip = getRequestClientIp(request);

      const rl1 = await rateLimiter.check(
        rateLimitKeys.forgotEmail(email),
        RATE_LIMITS.forgot.email.window,
        RATE_LIMITS.forgot.email.limit,
        RATE_LIMITS.forgot.email.softLimit,
      );
      if (!rl1.allowed) {
        if (rl1.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', { scope: 'forgot_email' });
        return rateLimitResponse(rl1.resetAt);
      }
      const rl2 = await rateLimiter.check(
        rateLimitKeys.forgotIp(ip),
        RATE_LIMITS.forgot.ip.window,
        RATE_LIMITS.forgot.ip.limit,
        RATE_LIMITS.forgot.ip.softLimit,
      );
      if (!rl2.allowed) {
        if (rl2.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', { scope: 'forgot_ip' });
        return rateLimitResponse(rl2.resetAt);
      }
      try {
        await verifyCaptchaIfRequired(rl1.captchaRequired || rl2.captchaRequired, captchaToken ?? null, ip);
      } catch (error) {
        if (error instanceof ApiError) return failResponse(error.code, error.message, error.status);
        throw error;
      }
      if (rl1.captchaRequired || rl2.captchaRequired) await recordSecurityEvent('captcha_challenged', null, ip, request.headers.get('user-agent') ?? '', { scope: 'forgot_password' });

      const user = await findUserByLowerEmail(email);
      if (user) {
        await invalidatePasswordResetTokens(user.id);

        const { raw, hash, id } = generateToken();
        const tokenTTL = 60 * 60 * 1000;
        await insertPasswordResetToken({
          id,
          userId: user.id,
          tokenHash: hash,
          purpose: 'password_reset',
          expiresAt: new Date(Date.now() + tokenTTL),
        });

        const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/password/reset?token=${raw}`;
        await sendPasswordResetEmail(user.email, url, {
          ip,
          time: new Date().toISOString(),
        });
      }

      return handleSuccess({ message: 'リセット-email を送信しました（存在する場合）' });
    },
  );
}
