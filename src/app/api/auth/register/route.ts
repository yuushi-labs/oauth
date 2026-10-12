import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
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

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: strongPasswordSchema,
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { email, username, password } = registerSchema.parse(body);

      const ipHash = request.headers.get('x-forwarded-for') ?? 'unknown';
      const rlKey = `rl:register:ip:${ipHash}`;
      const rl = await rateLimiter.check(rlKey, RATE_LIMITS.register.window, RATE_LIMITS.register.limit);
      if (!rl.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }

      const breachResult = await checkBreached(password);
      if (breachResult.breached) {
        return failResponse('VALIDATION_ERROR', 'このパスワードは漏洩している可能性があります', 400);
      }
      if (breachResult.failOpen) {
        await recordSecurityEvent('breach_check_fail_open', null, ipHash, request.headers.get('user-agent') ?? '');
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
      await sendVerificationEmail(email, url);

      await recordSecurityEvent('register', userId, ipHash, request.headers.get('user-agent') ?? '');

      return handleSuccess({ message: '確認-email を送信しました' });
    },
  );
}