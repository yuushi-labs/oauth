import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertPasswordResetToken, invalidatePasswordResetTokens } from '@/lib/db/queries/tokens';
import { findUserByLowerEmail } from '@/lib/db/queries/users';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendPasswordResetEmail } from '@/lib/auth/email/templates';
import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';

const forgotSchema = z.object({
  email: emailSchema,
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { email } = forgotSchema.parse(body);

      const ipHash = request.headers.get('x-forwarded-for') ?? 'unknown';
      const emailHash = Buffer.from(email).toString('hex').slice(0, 16);

      const rl1 = await rateLimiter.check(
        `rl:forgot:email:${emailHash}`,
        RATE_LIMITS.forgot.email.window,
        RATE_LIMITS.forgot.email.limit,
      );
      if (!rl1.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }
      const rl2 = await rateLimiter.check(
        `rl:forgot:ip:${ipHash}`,
        RATE_LIMITS.forgot.ip.window,
        RATE_LIMITS.forgot.ip.limit,
      );
      if (!rl2.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }

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
          ip: ipHash,
          time: new Date().toISOString(),
        });
      }

      return handleSuccess({ message: 'リセット-email を送信しました（存在する場合）' });
    },
  );
}