import { NextRequest } from 'next/server';
import { withAuthPipeline, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { generatePasskeyAuthenticationOptions } from '@/lib/auth/passkey/authentication';
import { issueChallenge } from '@/lib/auth/passkey/challenge';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * POST /api/auth/passkey/login/options — ログイン options を発行する（§8.4）。
 *
 * **未認証で呼べる**（`requireAuth: false`・D-34-07）。discoverable 対応のため
 * `allowCredentials` は空で発行し、`user_id` は `null` で challenge を保存する。
 * 応答は常に同一形で、ユーザーの存在有無を漏らさない（§46）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: false }, async () => {
    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const rl = await rateLimiter.check(
      rateLimitKeys.passkeyIp(ip),
      RATE_LIMITS.passkey.window,
      RATE_LIMITS.passkey.limit,
      RATE_LIMITS.passkey.softLimit,
    );
    if (!rl.allowed) {
      if (rl.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'passkey' });
      return rateLimitResponse(rl.resetAt);
    }

    const { id: challengeId, challenge } = await issueChallenge({
      userId: null,
      type: 'authentication',
    });
    const options = await generatePasskeyAuthenticationOptions({
      config: getWebauthnConfig(),
      challenge,
    });

    return handleSuccess({ options, challenge_id: challengeId });
  });
}
