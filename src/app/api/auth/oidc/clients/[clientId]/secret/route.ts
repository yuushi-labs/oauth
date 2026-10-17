import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { OidcClientForbiddenError, OidcClientNotFoundError, rotateOidcClientSecret } from '@/lib/oidc/clients';

type RouteContext = { params: Promise<{ clientId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  return withAuthPipeline(request, { requireAuth: true, requireReauth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const { clientId } = await context.params;

    const limit = RATE_LIMITS.oidcClients.mutation;
    const rateLimit = await rateLimiter.check(rateLimitKeys.oidcClientUser(user.id), limit.window, limit.limit, limit.softLimit);
    if (!rateLimit.allowed) {
      if (rateLimit.logRateLimited) {
        await recordSecurityEvent('rate_limited', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '', { scope: 'oidc_client_secret_rotate' });
      }
      return rateLimitResponse(rateLimit.resetAt);
    }

    try {
      const clientSecret = await rotateOidcClientSecret(clientId, {
        userId: user.id,
        ip: getRequestClientIp(request),
        userAgent: request.headers.get('user-agent') ?? '',
      });
      // Plaintext secret is returned exactly once and only its HMAC digest is stored.
      return handleSuccess({ clientSecret });
    } catch (error) {
      if (error instanceof OidcClientNotFoundError || error instanceof OidcClientForbiddenError) {
        return failResponse('NOT_FOUND', 'アプリが見つかりません', 404);
      }
      throw error;
    }
  });
}
