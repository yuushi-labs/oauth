import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { ApiError } from '@/lib/errors';
import {
  ClientValidationError,
  OidcClientForbiddenError,
  OidcClientNotFoundError,
  revokeOidcClient,
  updateOidcClient,
} from '@/lib/oidc/clients';

type RouteContext = { params: Promise<{ clientId: string }> };

function clientIdOf(context: RouteContext): Promise<string> {
  return context.params.then((params) => params.clientId);
}

/** Ownership failures answer 404 so other users' client IDs never leak existence. */
function clientErrorResponse(error: unknown): Response | null {
  if (error instanceof OidcClientNotFoundError || error instanceof OidcClientForbiddenError) {
    return failResponse('NOT_FOUND', 'アプリが見つかりません', 404);
  }
  return null;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, body }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const clientId = await clientIdOf(context);

    const limit = RATE_LIMITS.oidcClients.mutation;
    const rateLimit = await rateLimiter.check(rateLimitKeys.oidcClientUser(user.id), limit.window, limit.limit, limit.softLimit);
    if (!rateLimit.allowed) {
      if (rateLimit.logRateLimited) {
        await recordSecurityEvent('rate_limited', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '', { scope: 'oidc_client_update' });
      }
      return rateLimitResponse(rateLimit.resetAt);
    }

    try {
      await updateOidcClient(clientId, body, {
        userId: user.id,
        ip: getRequestClientIp(request),
        userAgent: request.headers.get('user-agent') ?? '',
      });
    } catch (error) {
      const failure = clientErrorResponse(error);
      if (failure) return failure;
      if (error instanceof ClientValidationError) throw new ApiError('VALIDATION_ERROR', error.issues.join(' / '));
      throw error;
    }
    return handleSuccess({ message: 'アプリを更新しました' });
  });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return withAuthPipeline(request, { requireAuth: true, requireReauth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const clientId = await clientIdOf(context);

    try {
      const revokedGrants = await revokeOidcClient(clientId, {
        userId: user.id,
        ip: getRequestClientIp(request),
        userAgent: request.headers.get('user-agent') ?? '',
      });
      return handleSuccess({ message: 'アプリ利用を停止しました', revokedGrantCount: revokedGrants });
    } catch (error) {
      const failure = clientErrorResponse(error);
      if (failure) return failure;
      throw error;
    }
  });
}
