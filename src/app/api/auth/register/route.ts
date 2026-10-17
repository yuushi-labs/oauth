import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { hashPassword } from '@/lib/auth/password';
import { strongPasswordSchema } from '@/lib/auth/strength';
import { checkBreached } from '@/lib/auth/breached';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertEmailVerificationToken } from '@/lib/db/queries/tokens';
import { createUser } from '@/lib/db/queries/users';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendVerificationEmail } from '@/lib/auth/email/templates';
import { newId } from '@/lib/util/id';
import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';
import { usernameSchema } from '@/lib/validate/username';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: strongPasswordSchema,
  captchaToken: z.string().optional(),
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { email, username, password, captchaToken } = registerSchema.parse(body);

      const ip = getRequestClientIp(request);
      const rl = await rateLimiter.check(rateLimitKeys.registerIp(ip), RATE_LIMITS.register.window, RATE_LIMITS.register.limit, RATE_LIMITS.register.softLimit);
      if (!rl.allowed) {
        if (rl.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', { scope: 'register' });
        return rateLimitResponse(rl.resetAt);
      }
      try {
        await verifyCaptchaIfRequired(rl.captchaRequired, captchaToken ?? null, ip);
      } catch (error) {
        if (error instanceof ApiError) return failResponse(error.code, error.message, error.status);
        throw error;
      }
      if (rl.captchaRequired) await recordSecurityEvent('captcha_challenged', null, ip, request.headers.get('user-agent') ?? '', { scope: 'register' });

      const breachResult = await checkBreached(password);
      if (breachResult.breached) {
        return failResponse('VALIDATION_ERROR', 'このパスワードは漏洩している可能性があります', 400);
      }
      if (breachResult.failOpen) {
        await recordSecurityEvent('breach_check_fail_open', null, ip, request.headers.get('user-agent') ?? '');
      }

      const passwordHash = await hashPassword(password);
      const userId = newId('usr');
      try {
        await createUser({
          id: userId,
          email,
          username,
          passwordHash,
          status: 'pending_email',
          emailVerified: false,
          roleId: 'role_user',
        });
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err?.code === '23505') {
          // 列挙攻撃対策: 成功時と同じメッセージを返す
          return handleSuccess({ message: '確認メールを送信しました' });
        }
        throw e;
      }

      const { raw, hash, id } = generateToken();
      const tokenTTL = 30 * 60 * 1000;
      await insertEmailVerificationToken({
        id,
        userId,
        tokenHash: hash,
        purpose: 'email_verification',
        expiresAt: new Date(Date.now() + tokenTTL),
      });

      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/verify-email?token=${raw}`;
      // Best-effort: a mail failure must not turn this into a 500, and the response message
      // must stay identical to the success path so account enumeration stays impossible (§46).
      await deliverEmailSafely({
        kind: 'register_verification',
        userId,
        ip,
        userAgent: request.headers.get('user-agent') ?? '',
        send: () => sendVerificationEmail(email, url),
      });

      await recordSecurityEvent('register', userId, ip, request.headers.get('user-agent') ?? '');

      return handleSuccess({ message: '確認-email を送信しました' });
    },
  );
}
