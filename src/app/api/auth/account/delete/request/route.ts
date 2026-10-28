import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertAccountDeletionRequest, invalidateAccountDeletionRequests } from '@/lib/db/queries/tokens';
import { sendAccountDeletionConfirmEmail } from '@/lib/auth/email/templates';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { getRequestClientIp } from '@/lib/auth/session';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';

const TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * POST /api/auth/account/delete/request — メール確認による退会リクエスト（§24）。
 *
 * 2FA / Passkey を持たない利用者の確認手段。ここではまだ削除せず、確認リンクを
 * メールで送るだけ。削除は `POST /api/auth/account/delete/confirm` がトークンを
 * 消費したときに確定する。再要求すると未消費の旧トークンは無効化する（D-16）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) {
      return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    }

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    for (const [key, limit, scope] of [
      [rateLimitKeys.accountDeleteEmailUser(user.id), RATE_LIMITS.accountDeleteEmail.user, 'account_delete_email_user'],
      [rateLimitKeys.accountDeleteEmailIp(ip), RATE_LIMITS.accountDeleteEmail.ip, 'account_delete_email_ip'],
    ] as const) {
      const result = await rateLimiter.check(key, limit.window, limit.limit, limit.softLimit);
      if (!result.allowed) {
        if (result.logRateLimited) {
          await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope });
        }
        return rateLimitResponse(result.resetAt);
      }
    }

    await invalidateAccountDeletionRequests(user.id);

    const { raw, hash, id } = generateToken();
    await insertAccountDeletionRequest({
      id,
      userId: user.id,
      tokenHash: hash,
      purpose: 'account_deletion',
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/account/delete/confirm?token=${raw}`;
    await deliverEmailSafely({
      kind: 'account_deletion',
      userId: user.id,
      ip,
      userAgent,
      send: () => sendAccountDeletionConfirmEmail(user.email, url),
    });

    await recordSecurityEvent('account_deletion_requested', user.id, ip, userAgent, { method: 'email' });

    return handleSuccess({ message: '確認メールを送信しました' });
  });
}
