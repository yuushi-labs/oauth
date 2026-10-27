import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertEmailChangeRequest, invalidateEmailChangeRequests } from '@/lib/db/queries/tokens';
import { sendVerificationEmail } from '@/lib/auth/email/templates';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { getRequestClientIp } from '@/lib/auth/session';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';

const changeSchema = z.object({
  new_email: emailSchema,
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user, session, body }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }

      const { new_email } = changeSchema.parse(body);

      // メール送信を伴うため、利用者単位と IP 単位の両方で制限する（§4.3 / §18）。
      const ip = getRequestClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? '';
      for (const [key, limit, scope] of [
        [rateLimitKeys.emailChangeUser(user.id), RATE_LIMITS.emailChange.user, 'email_change_user'],
        [rateLimitKeys.emailChangeIp(ip), RATE_LIMITS.emailChange.ip, 'email_change_ip'],
      ] as const) {
        const result = await rateLimiter.check(key, limit.window, limit.limit, limit.softLimit);
        if (!result.allowed) {
          if (result.logRateLimited) {
            await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope });
          }
          return rateLimitResponse(result.resetAt);
        }
      }

      await invalidateEmailChangeRequests(user.id);

      const { raw, hash, id } = generateToken();
      const tokenTTL = 30 * 60 * 1000;
      await insertEmailChangeRequest({
        id,
        userId: user.id,
        tokenHash: hash,
        purpose: 'email_change',
        newEmail: new_email,
        expiresAt: new Date(Date.now() + tokenTTL),
      });

      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/email/change/confirm?token=${raw}`;
      // Best-effort delivery: a mail failure must not become a 500 (BUG-6).
      await deliverEmailSafely({
        kind: 'email_change',
        userId: user.id,
        ip,
        userAgent,
        send: () => sendVerificationEmail(new_email, url),
      });

      return handleSuccess({ message: '変更通知メールを送信しました' });
    },
  );
}