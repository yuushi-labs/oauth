import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getEnv } from '@/lib/env';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import {
  buildAuthorizeUrl,
  createClientTestState,
  getClientTestCookieName,
} from '@/lib/oidc/client-test';
import { connectionTestRedirectUri, isRegisteredRedirectUri } from '@/lib/oidc/client-validation';
import {
  OidcClientForbiddenError,
  OidcClientNotFoundError,
  requireManageableClient,
} from '@/lib/oidc/clients';
import { ApiError } from '@/lib/errors';

type RouteContext = { params: Promise<{ clientId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session, body }) => {
    if (!user || !session) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const { clientId } = await context.params;

    const limit = RATE_LIMITS.oidcClients.mutation;
    const rateLimit = await rateLimiter.check(rateLimitKeys.oidcClientUser(user.id), limit.window, limit.limit, limit.softLimit);
    if (!rateLimit.allowed) return rateLimitResponse(rateLimit.resetAt);

    const issuer = getEnv().OIDC_ISSUER;
    if (!issuer) throw new ApiError('VALIDATION_ERROR', 'OIDC Provider が有効になっていません');

    let client;
    try {
      client = await requireManageableClient(clientId, user.id);
    } catch (error) {
      if (error instanceof OidcClientNotFoundError || error instanceof OidcClientForbiddenError) {
        return failResponse('NOT_FOUND', 'アプリが見つかりません', 404);
      }
      throw error;
    }

    // D-26-06: the owner adds the test redirect URI manually, so it must already be registered.
    const redirectUri = connectionTestRedirectUri(getEnv().NEXT_PUBLIC_APP_URL);
    if (!isRegisteredRedirectUri(client.redirectUris, redirectUri)) {
      throw new ApiError('VALIDATION_ERROR', `接続テストには次のリダイレクト URI の登録が必要です: ${redirectUri}`);
    }

    const clientSecret = client.clientType === 'confidential' ? readSubmittedSecret(body) : null;
    if (client.clientType === 'confidential' && !clientSecret) {
      throw new ApiError('VALIDATION_ERROR', 'client secret を入力してください');
    }

    const { value, state } = createClientTestState({
      clientId,
      sessionId: session.id,
      redirectUri,
      scopes: client.allowedScopes,
      clientSecret,
    });

    const response = handleSuccess({ authorizeUrl: buildAuthorizeUrl(state, issuer), redirectUri }) as NextResponse;
    response.cookies.set(getClientTestCookieName(), value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
}

function readSubmittedSecret(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { client_secret?: unknown }).client_secret;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) return null;
  return trimmed;
}
