import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { setSessionCookie, setAnonCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
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

      const ipHash = request.headers.get('x-forwarded-for') ?? 'unknown';
      const emailHash = Buffer.from(email_or_username.toLowerCase()).toString('hex').slice(0, 16);

      const rl1 = await rateLimiter.check(
        `rl:login:ip:${ipHash}`,
        RATE_LIMITS.login.ip.window,
        RATE_LIMITS.login.ip.limit,
      );
      if (!rl1.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }
      const rl2 = await rateLimiter.check(
        `rl:login:acct:${emailHash}`,
        RATE_LIMITS.login.account.window,
        RATE_LIMITS.login.account.limit,
      );
      if (!rl2.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }
      const rl3 = await rateLimiter.check(
        `rl:login:ip+acct:${ipHash}:${emailHash}`,
        RATE_LIMITS.login.ipAccount.window,
        RATE_LIMITS.login.ipAccount.limit,
      );
      if (!rl3.allowed) {
        return failResponse('RATE_LIMITED', 'リクエストが多すぎます', 429);
      }

      const user = await findUserByEmailOrUsername(email_or_username);
      const valid = user ? await verifyPassword(password, user.passwordHash ?? '') : false;

      if (!user || !valid) {
        await recordSecurityEvent('login_failed', null, ipHash, request.headers.get('user-agent') ?? '');
        return failResponse('INVALID_CREDENTIALS', '認証情報が正しくありません', 401);
      }

      if (user.status === 'suspended') {
        await recordSecurityEvent('login_failed', user.id, ipHash, request.headers.get('user-agent') ?? '');
        return failResponse('ACCOUNT_SUSPENDED', 'このアカウントは利用できません', 403);
      }

      const { token, session } = await createSession(user.id, request);
      await setSessionCookie(token);
      await setAnonCookie(session.csrfSecret);

      await recordSecurityEvent('login_success', user.id, ipHash, request.headers.get('user-agent') ?? '');

      return handleSuccess({ message: 'ログインしました' });
    },
  );
}