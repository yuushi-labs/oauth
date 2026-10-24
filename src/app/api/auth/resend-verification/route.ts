import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { generateToken } from '@/lib/auth/tokens/generate';
import { insertEmailVerificationToken, invalidateEmailVerificationTokens } from '@/lib/db/queries/tokens';
import { findUserByLowerEmail } from '@/lib/db/queries/users';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { sendResendVerificationEmail } from '@/lib/auth/email/templates';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';
import { ApiError } from '@/lib/errors';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { resendVerificationSchema } from '@/lib/validate/resend';

/**
 * POST /api/auth/resend-verification — 確認メールの再送（未認証対応・D-33-22）。
 *
 * `requireAuth: false`。`body.email` で対象を決める（未確認ユーザーはログインできないため）。
 * **応答は常に同一**（存在しない / 確認済み / 停止中 / 削除済みでも同じ 200）。列挙対策（§46）。
 * 実際に送るのは `pending_email` かつ `email_verified = false` のときだけ。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: false }, async ({ user, body }) => {
    const parsed = resendVerificationSchema.safeParse(body ?? {});
    const requestedEmail = parsed.success ? parsed.data.email : undefined;
    const captchaToken = parsed.success ? (parsed.data.captchaToken ?? null) : null;

    // 後方互換: `body.email` が無い認証済み経路（旧 UI）は、そのセッションの user を対象にする。
    const targetUser = requestedEmail ? await findUserByLowerEmail(requestedEmail) : user;

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';
    // 未認証経路は user_id を確定できない場合がある（列挙の材料を残さない・§8.9）。
    const eventUserId = user?.id ?? null;

    // 未認証経路のキー（resendEmail）と既存キー（resendUser / resendIp）を両方課す。
    const checks: [string, { window: number; limit: number; softLimit: number }, string][] = [
      [rateLimitKeys.resendIp(ip), RATE_LIMITS.resend.ip, 'resend_ip'],
    ];
    if (requestedEmail) {
      checks.unshift([rateLimitKeys.resendEmail(requestedEmail), RATE_LIMITS.resend.user, 'resend_email']);
    }
    if (targetUser) {
      checks.unshift([rateLimitKeys.resendUser(targetUser.id), RATE_LIMITS.resend.user, 'resend_user']);
    }

    let captchaRequired = false;
    for (const [key, limit, scope] of checks) {
      const result = await rateLimiter.check(key, limit.window, limit.limit, limit.softLimit);
      if (!result.allowed) {
        if (result.logRateLimited) {
          await recordSecurityEvent('rate_limited', eventUserId, ip, userAgent, { scope });
        }
        return rateLimitResponse(result.resetAt);
      }
      captchaRequired = captchaRequired || result.captchaRequired;
    }

    try {
      await verifyCaptchaIfRequired(captchaRequired, captchaToken, ip);
    } catch (error) {
      if (error instanceof ApiError) return failResponse(error.code, error.message, error.status);
      throw error;
    }
    if (captchaRequired) {
      await recordSecurityEvent('captcha_challenged', eventUserId, ip, userAgent, { scope: 'resend_verification' });
    }

    // 送信対象は未確認ユーザーのみ。それ以外は何もせず同一応答を返す（列挙対策）。
    if (targetUser && targetUser.emailVerified === false && targetUser.status === 'pending_email') {
      await invalidateEmailVerificationTokens(targetUser.id);

      const { raw, hash, id } = generateToken();
      const tokenTTL = 30 * 60 * 1000;
      await insertEmailVerificationToken({
        id,
        userId: targetUser.id,
        tokenHash: hash,
        purpose: 'email_verification',
        expiresAt: new Date(Date.now() + tokenTTL),
      });

      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/verify-email?token=${raw}`;
      await deliverEmailSafely({
        kind: 'resend_verification',
        userId: targetUser.id,
        ip,
        userAgent,
        send: () => sendResendVerificationEmail(targetUser.email, url),
      });
    }

    return handleSuccess({ message: '確認メールを送信しました' });
  });
}
