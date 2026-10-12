import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertEmailVerificationToken, invalidateEmailVerificationTokens } from '@/lib/db/queries/tokens';
import { findUserById } from '@/lib/db/queries/users';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendVerificationEmail } from '@/lib/auth/email/templates';

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user }) => {
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

      const ipHash = request.headers.get('x-forwarded-for') ?? 'unknown';
      const rl1 = await rateLimiter.check(
        `rl:resend:user:${user.id}`,
        RATE_LIMITS.resend.user.window,
        RATE_LIMITS.resend.user.limit,
      );
      if (!rl1.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }
      const rl2 = await rateLimiter.check(
        `rl:resend:ip:${ipHash}`,
        RATE_LIMITS.resend.ip.window,
        RATE_LIMITS.resend.ip.limit,
      );
      if (!rl2.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }

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