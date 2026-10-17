import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getEnv } from '@/lib/env';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { ApiError } from '@/lib/errors';
import {
  ClientValidationError,
  createOidcClient,
  listOidcClients,
  OidcClientLimitError,
  parseClientInput,
  requireWebOriginForPublicClient,
} from '@/lib/oidc/clients';

export async function GET(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const clients = await listOidcClients({ id: user.id, roleId: user.roleId });
    return handleSuccess({
      clients,
      maxClientsPerUser: getEnv().OIDC_MAX_CLIENTS_PER_USER,
      clientCount: clients.length,
    });
  });
}

export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, body }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const limit = RATE_LIMITS.oidcClients.create;
    const rateLimit = await rateLimiter.check(rateLimitKeys.oidcClientUser(user.id), limit.window, limit.limit, limit.softLimit);
    if (!rateLimit.allowed) {
      if (rateLimit.logRateLimited) {
        await recordSecurityEvent('rate_limited', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '', { scope: 'oidc_client_create' });
      }
      return rateLimitResponse(rateLimit.resetAt);
    }

    let input;
    try {
      input = parseClientInput(body);
      requireWebOriginForPublicClient(input.clientType, input.webOrigins);
    } catch (error) {
      if (error instanceof ClientValidationError) throw new ApiError('VALIDATION_ERROR', error.issues.join(' / '));
      throw error;
    }

    try {
      const created = await createOidcClient(
        input,
        { userId: user.id, ip: getRequestClientIp(request), userAgent: request.headers.get('user-agent') ?? '' },
        { maxClientsPerUser: getEnv().OIDC_MAX_CLIENTS_PER_USER },
      );
      // The plaintext secret is returned exactly once; only its HMAC digest is stored.
      const response = handleSuccess({ clientId: created.clientId, clientSecret: created.clientSecret }, 201);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      if (error instanceof OidcClientLimitError) throw new ApiError('VALIDATION_ERROR', error.message, 409);
      throw error;
    }
  });
}
