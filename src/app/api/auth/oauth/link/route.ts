import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, handleApiError } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { ApiError } from '@/lib/errors';
import { getProvider } from '@/lib/auth/oauth/registry';
import { codeChallengeFor, issueOAuthState } from '@/lib/auth/oauth/state';
import { hasProviderLinked } from '@/lib/auth/oauth/accounts';
import { oauthLinkBodySchema } from '@/lib/validate/oauth';

export const dynamic = 'force-dynamic';

/**
 * 連携の開始（**link intent**・§11）。
 *
 * login の開始（GET）とは別に POST で受け付ける。理由は 3 つ:
 *
 * 1. **「誰が」紐付けるのか**を確定させる。`state` に `user_id` を持たせ、callback で
 *    現セッションと照合する（§7.8 T3）。GET で始めると state's 所有者が曖昧になる。
 * 2. 再認証（`requireReauth`）を課せる。POST + CSRF トークンを使う経路なので、罠ページから
 *    開始させること自体を防げる（§7.8 T4）。
 * 3. login と state を共有しない。link 用 state を login フローで使い回せない。
 */
export async function POST(request: NextRequest): Promise<Response> {
  return withAuthPipeline(request, { requireAuth: true, requireReauth: true }, async ({ user, body }) => {
    if (!user) throw new ApiError('SESSION_EXPIRED');

    const { provider: providerId } = oauthLinkBodySchema.parse(body);
    const provider = getProvider(providerId, process.env);
    if (!provider) throw new ApiError('INVALID_PROVIDER');

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const limited = await rateLimiter.check(
      rateLimitKeys.oauthStart(ip),
      RATE_LIMITS.oauth.start.window,
      RATE_LIMITS.oauth.start.limit,
      RATE_LIMITS.oauth.start.softLimit,
    );
    if (!limited.allowed) {
      if (limited.logRateLimited) {
        await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'oauth_link' });
      }
      throw new ApiError('RATE_LIMITED');
    }

    if (await hasProviderLinked(user.id, provider.id)) {
      throw new ApiError('ACCOUNT_ALREADY_LINKED');
    }

    const issued = await issueOAuthState({
      provider: provider.id,
      intent: 'link',
      userId: user.id,
      redirectTo: null,
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
    authorizeUrl.searchParams.set('code_challenge', codeChallengeFor(issued.codeVerifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('access_type', 'online');

    // クライアントは 303 で authorize URL に遷移する。JSON ではなく 303 を返す。
    return NextResponse.json(
      { success: true, data: { authorizeUrl: authorizeUrl.toString() } },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  });
}

/** この経路は POST 専用。GET で 200 を返すと「存在するが動かない」API になるため 405 にする。 */
export async function GET(): Promise<NextResponse> {
  return handleApiError(new ApiError('VALIDATION_ERROR', 'Method Not Allowed', 405));
}