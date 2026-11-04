import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { hashPassword } from '@/lib/auth/password';
import { strongPasswordSchema } from '@/lib/auth/strength';
import { checkBreached } from '@/lib/auth/breached';
import { createUser } from '@/lib/db/queries/users';
import { isUniqueViolation } from '@/lib/db/sql-state';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { newId } from '@/lib/util/id';
import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';
import { usernameSchema } from '@/lib/validate/username';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import { m } from '@/messages/ja';

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: strongPasswordSchema,
  captchaToken: z.string().optional(),
});

/**
 * メール送受信による認証を廃止したため、登録は**確認メールを送らずに即時有効化**する
 * （D-40-01）。`email_verified` は true・`status` は `active` で作る。確認メール送信・
 * トークン発行の内部実装（`sendVerificationEmail` / `insertEmailVerificationToken` 等）は
 * 復旧用に残置している（`/api/auth/verify-email` も同様）。
 */
const REGISTERED_MESSAGE = m('auth.registerDone');

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
          status: 'active',
          emailVerified: true,
          roleId: 'role_user',
        });
      } catch (e: unknown) {
        if (isUniqueViolation(e)) {
          // 列挙攻撃対策: 成功時と同じメッセージを返す
          return handleSuccess({ message: REGISTERED_MESSAGE });
        }
        throw e;
      }

      await recordSecurityEvent('register', userId, ip, request.headers.get('user-agent') ?? '');

      return handleSuccess({ message: REGISTERED_MESSAGE });
    },
  );
}
