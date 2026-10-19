import { NextRequest, NextResponse } from 'next/server';
import { ApiError } from '@/lib/errors';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { handleApiError, rateLimitResponse } from '@/lib/api/utils';
import { getProvider } from '@/lib/auth/oauth/registry';
import { codeChallengeFor, issueOAuthState } from '@/lib/auth/oauth/state';
import { oauthStartQuerySchema } from '@/lib/validate/oauth';

export const dynamic = 'force-dynamic';

/**
 * 社会ログイン（**login intent**）の認可開始（§12.2）。
 *
 * GET なので CSRF トークンは要求しない（Spray 攻撃は GET の副作用が無いので成立しにくく、
 * 遷移を跨いだ時点で state と PKCE が防御になる）。ただしレート制限は掛ける。
 *
 * 未登録 provider と未設定 provider は**どちらも 404 INVALID_PROVIDER** に落とす。
 * 「この provider は存在するが設定されていない」と教えない。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  try {
    return await startLogin(request, (await params).provider);
  } catch (error) {
    return handleApiError(error);
  }
}

async function startLogin(request: NextRequest, providerId: string): Promise<NextResponse> {
  const provider = getProvider(providerId, process.env);
  if (!provider) {
    throw new ApiError('INVALID_PROVIDER');
  }

  const ip = getRequestClientIp(request);
  const limited = await rateLimiter.check(
    rateLimitKeys.oauthStart(ip),
    RATE_LIMITS.oauth.start.window,
    RATE_LIMITS.oauth.start.limit,
    RATE_LIMITS.oauth.start.softLimit,
  );
  if (!limited.allowed) {
    if (limited.logRateLimited) {
      await recordSecurityEvent('rate_limited', null, ip, request.headers.get('user-agent') ?? '', {
        scope: 'oauth_start',
      });
    }
    return rateLimitResponse(limited.resetAt);
  }

  const { redirect_to } = oauthStartQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  const issued = await issueOAuthState({
    provider: provider.id,
    intent: 'login',
    userId: null,
    redirectTo: redirect_to ?? null,
  });

  const authorizeUrl = new URL(provider.authorizationEndpoint);
  authorizeUrl.searchParams.set('client_id', process.env[provider.envKeys.clientId] ?? '');
  authorizeUrl.searchParams.set('redirect_uri', issued.redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', provider.scope);
  authorizeUrl.searchParams.set('state', issued.state);
  if (provider.protocol === 'oidc') {
    authorizeUrl.searchParams.set('nonce', issued.nonce);
  }
  // PKCE は S256 固定。plain は許さない（§9.3）。
  authorizeUrl.searchParams.set('code_challenge', codeChallengeFor(issued.codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  // refresh token を求めない（D-06）。access_type を指定しないと provider 側の
  // 設定によっては refresh token が返り、保存も要求もしないのに握り込むことになる。
  authorizeUrl.searchParams.set('access_type', 'online');

  return NextResponse.redirect(authorizeUrl, {
    status: 303,
    headers: { 'Cache-Control': 'no-store' },
  });
}