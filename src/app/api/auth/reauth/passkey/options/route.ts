import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { generatePasskeyAuthenticationOptions } from '@/lib/auth/passkey/authentication';
import { issueChallenge } from '@/lib/auth/passkey/challenge';
import { listCredentialsByUser } from '@/lib/db/queries/webauthn';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * POST /api/auth/reauth/passkey/options — 再認証用 Passkey challenge を発行する（D-34-12）。
 *
 * ログイン中のユーザーの credential を `allowCredentials` に入れ、`user_id` 付きで
 * challenge を保存する。`requireStrongReauth` の `passkeyVerifier` がこれを消費する。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const rl = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!rl.allowed) {
      if (rl.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'passkey' });
      return rateLimitResponse(rl.resetAt);
    }

    const credentials = await listCredentialsByUser(user.id);

    const { id: challengeId, challenge } = await issueChallenge({
      userId: user.id,
      type: 'authentication',
    });
    const options = await generatePasskeyAuthenticationOptions({
      credentials: credentials.map((row) => ({
        credentialId: row.credentialId,
        transports: row.transports,
      })),
      config: getWebauthnConfig(),
      challenge,
    });

    return handleSuccess({ options, challenge_id: challengeId });
  });
}
