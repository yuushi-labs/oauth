import { NextRequest, NextResponse } from 'next/server';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { createSession, getRequestClientIp, getSession } from '@/lib/auth/session';
import {
  buildAnonCookie,
  buildSocialClaimCookie,
  generateAnonCsrfSecret,
  getAnonCookieName,
  getAnonCsrfSecret,
  setAnonCookie,
  setSessionCookie,
} from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { isFirstSessionFromDevice, notifyNewDeviceLogin } from '@/lib/auth/notifications';
import { evaluateAndRecordLoginRisk } from '@/lib/auth/login-risk';
import { getCookieToken, handleApiError, rateLimitResponse } from '@/lib/api/utils';
import { ApiError } from '@/lib/errors';
import { getProvider } from '@/lib/auth/oauth/registry';
import { redirectUriFor } from '@/lib/auth/oauth/redirect-uri';
import { sessionMaxAgeSecondsForRole } from '@/lib/auth/admin-policy';
import { ProviderError } from '@/lib/auth/oauth/provider-error';
import { consumeOAuthState } from '@/lib/auth/oauth/state';
import { issueSocialClaim } from '@/lib/auth/oauth/social-claim';
import { completeLogin } from '@/lib/auth/oauth/complete-login';
import { completeLink } from '@/lib/auth/oauth/complete-link';
import { findUserById } from '@/lib/db/queries/users';
import { logger } from '@/lib/util/logger';
import { oauthCallbackQuerySchema } from '@/lib/validate/oauth';
import type { Identity, OAuthProviderEntry, OAuthProviderId } from '@/lib/auth/oauth/types';
import type { SocialProvider } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/** login intent の失敗時に利用者へ見せる戻り先。どの画面でも 403 の詳細は出さない。 */
const LOGIN_ERROR_REDIRECTS = {
  cancelled: '/login?error=cancelled',
} as const;

/** 紐付きが無いときの確認画面（Phase 4-B / D-32-01）。 */
const SOCIAL_CONFIRM_PATH = '/login/social-confirm';

/**
 * 社会ログインのコールバック（§12.2）。
 *
 * `withAuthPipeline` は**通さない**。この経路は GET かつ provider からの
 * top-level navigation なので CSRF トークンを付けられない（§8.4 の例外規定）。
 * CSRF とセッション固定は `state`（OIDC は `nonce`）+ PKCE と、
 * **完了時に必ず新しいセッションを発行すること**で担保する。
 *
 * 分岐は `intent` で行う。login と link は判定ルールが別（§11）なので混ぜない。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  try {
    return await handleCallback(request, (await params).provider);
  } catch (error) {
    return handleApiError(error);
  }
}

async function handleCallback(request: NextRequest, providerId: string): Promise<NextResponse> {
  // 未登録と未設定はどちらも 404 に落とす（「存在するが未設定」と教えない）。
  const provider = getProvider(providerId, process.env);
  if (!provider) throw new ApiError('INVALID_PROVIDER');

  const ip = getRequestClientIp(request);
  const userAgent = request.headers.get('user-agent') ?? '';

  const limited = await rateLimiter.check(
    rateLimitKeys.oauthCallback(ip),
    RATE_LIMITS.oauth.callback.window,
    RATE_LIMITS.oauth.callback.limit,
    RATE_LIMITS.oauth.callback.softLimit,
  );
  if (!limited.allowed) {
    if (limited.logRateLimited) {
      await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'oauth_callback' });
    }
    return rateLimitResponse(limited.resetAt);
  }

  // ★ `Origin` / `Referer` は**検証しない**。
  //
  // この経路は provider から top-level GET で戻ってくるので、参照元は
  // *provider 自身*（accounts.google.com など）になる。アプリ自身のオリジンでは
  // ないので、同一オリジン判定をここへかけると**正常な連携がすべて 403 になる**。
  //
  // CSRF の防御は OAuth 仕様が定める次の 2 点が担う:
  //   - `state`: サーバ側の 1 回限り行に紐付き、所持者だけが持ち回れる
  //   - PKCE:   `code_verifier` を持つ者だけが token を引き出せる
  // これらは参照元ヘッダに頼らないので、ブラウザがヘッダの有無をどう送っても
  // 同じ強度で防げる（§8.4 の例外規定）。

  const query = oauthCallbackQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  // 利用者が認可を中断したケース。state は消費しないので、そのまま再挑戦できる。
  if (query.error) {
    await recordSecurityEvent('login_failed', null, ip, userAgent, {
      provider: provider.id,
      error: 'access_denied',
    });
    return redirectToPath(LOGIN_ERROR_REDIRECTS.cancelled);
  }
  if (!query.code || !query.state) {
    await recordSecurityEvent('login_failed', null, ip, userAgent, { provider: provider.id });
    throw new ApiError('INVALID_STATE');
  }

  // ★ 1 回限りの消費。2 回目以降は 0 行更新＝null になるので、ここで認可コードの
  // 再利用（replay）が止まる。callback の URL 自体は絶対にログに出さない（code を含むため）。
  const state = await consumeOAuthState(query.state, provider.id);
  if (!state) {
    await recordSecurityEvent('login_failed', null, ip, userAgent, {
      provider: provider.id,
      state_present: true,
    });
    throw new ApiError('INVALID_STATE');
  }

  const identity = await resolveIdentity({
    provider,
    code: query.code,
    codeVerifier: state.codeVerifier,
    nonce: state.nonce,
  }).catch((error: unknown) => {
    // provider 側の障害・署名検証の失敗・nonce 不一致は**すべて** 401 に落とす。
    // jose が投げる JWSSignatureVerificationFailed などは ProviderError ではないので、
    // ProviderError だけを拾うと 500 が出て内部情報が漏れる（fail closed）。
    logger.warn('oauth provider verification failed', {
      provider: provider.id,
      reason: error instanceof ProviderError ? error.reason : 'verification_error',
    });
    return null;
  });

  if (!identity) {
    await recordSecurityEvent('login_failed', null, ip, userAgent, {
      provider: provider.id,
      error: 'verification_failed',
    });
    throw new ApiError('INVALID_CREDENTIALS', '認証情報を確認できませんでした', 401);
  }

  if (state.intent === 'link') {
    return completeLinkCallback(request, provider.id, identity, ip, userAgent);
  }
  return completeLoginCallback({
    request,
    provider: provider.id,
    identity,
    redirectTo: state.redirectTo,
    ip,
    userAgent,
  });
}

async function resolveIdentity(args: {
  provider: OAuthProviderEntry;
  code: string;
  /** state 行から取り出した PKCE verifier。callback のクエリからは取らない。 */
  codeVerifier: string;
  nonce: string;
}): Promise<Identity> {
  const { provider, code, codeVerifier, nonce } = args;
  const clientId = process.env[provider.envKeys.clientId] ?? '';
  const clientSecret = process.env[provider.envKeys.clientSecret] ?? '';

  const tokens = await provider.exchangeCode({
    code,
    codeVerifier,
    redirectUri: redirectUriFor(provider.id),
    clientId,
    clientSecret,
  });

  // OIDC は ID token を検証してから claims を identity に変える。
  // access_token を検証せず claims を拾うと alg=none / aud 差し替え攻撃を通してしまう。
  if (provider.verifyIdToken) {
    if (!tokens.idToken) throw new ProviderError('id_token_invalid');
    const claims = await provider.verifyIdToken({ idToken: tokens.idToken, nonce, clientId });
    return provider.fetchIdentity({ accessToken: tokens.accessToken, idTokenClaims: claims });
  }

  return provider.fetchIdentity({ accessToken: tokens.accessToken });
}

async function completeLoginCallback(args: {
  request: NextRequest;
  provider: SocialProvider;
  identity: Identity;
  redirectTo: string | null;
  ip: string;
  userAgent: string;
}): Promise<NextResponse> {
  const { request, provider, identity, redirectTo, ip, userAgent } = args;

  const outcome = await completeLogin({ provider, identity });

  switch (outcome.kind) {
    case 'suspended':
      await recordSecurityEvent('login_failed', null, ip, userAgent, {
        provider,
        error: 'account_suspended',
      });
      throw new ApiError('ACCOUNT_SUSPENDED');
    case 'needs_confirmation':
      return enterSocialConfirm(request, outcome.emailOwnerId, outcome.identity, provider);
    default:
      break;
  }

  // 既存ログイン・新規登録のどちらでも**必ず新しいセッションを発行する**（§6.2）。
  // 管理者は 8 時間の短命セッション（§51・D-35-03）。
  const sessionMaxAgeSeconds = sessionMaxAgeSecondsForRole(outcome.user.roleId);
  const { token, session } = await createSession(outcome.user.id, request, {
    ...(sessionMaxAgeSeconds ? { sessionMaxAgeSeconds } : {}),
  });
  await setSessionCookie(token);
  await setAnonCookie(session.csrfSecret);

  try {
    const isNewDevice = await isFirstSessionFromDevice(
      outcome.user.id,
      session.id,
      session.ipHash,
      session.deviceName,
    );
    if (isNewDevice) {
      await notifyNewDeviceLogin({
        userId: outcome.user.id,
        userEmail: outcome.user.email,
        deviceName: session.deviceName,
        ipMasked: session.ipMasked,
        ipCountry: null,
        occurredAt: new Date(),
        ip,
        userAgent,
      });
    }
  } catch {
    // 通知の判定・送信に失敗してもログイン自体は失敗にしない（best-effort）
  }

  // 不審ログイン検知（§57）。既定は通知のみ・失敗してもログインは失敗にしない。
  try {
    await evaluateAndRecordLoginRisk({
      userId: outcome.user.id,
      currentSessionId: session.id,
      ipHash: session.ipHash,
      deviceName: session.deviceName,
      ip,
      userAgent,
    });
  } catch {
    // リスク評価の失敗でもログインは成功として扱う
  }

  await recordSecurityEvent('login_success', outcome.user.id, ip, userAgent, { provider });

  return redirectToPath(redirectTo ?? '/');
}

/**
 * 紐付きが無いときは**エラーで止めない**。確認待ち（claim）を発行して画面へ送る（D-32-01）。
 *
 * ここで新規登録も連携も行わない。利用者が画面で「作る」か「password でログインして連携」
 * を選んだときだけ、完了 API が実行する。
 */
async function enterSocialConfirm(
  request: NextRequest,
  emailOwnerId: string | null,
  identity: Identity,
  provider: SocialProvider,
): Promise<NextResponse> {
  const { token } = await issueSocialClaim({ provider, identity, emailOwnerId });

  // ここでは何も記録しない。まだ「完了」していないので login_failed ではなく、
  // 新しい event type も増やさない（D-32-15）。完了した時点で oauth_linked を記録する。
  //
  // ★ claim token と anon Cookie を**この 1 つの応答で**書く（BUG-15）。
  // 確認画面は Server Component なので Cookie を書けない。あとからクライアントに
  // `/api/auth/csrf` を叩かせると Cookie 保存のタイミングが読めず、トークンと
  // Cookie が食い合って 403 になる。ここで先に用意しておく。
  const anonCookie = request.cookies.get(getAnonCookieName())?.value ?? null;
  const anonSecret = getAnonCsrfSecret(anonCookie) ?? generateAnonCsrfSecret();

  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', buildSocialClaimCookie(token));
  headers.append('Set-Cookie', buildAnonCookie(anonSecret));

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';
  return NextResponse.redirect(new URL(SOCIAL_CONFIRM_PATH, base), { status: 303, headers });
}

async function completeLinkCallback(
  request: NextRequest,
  provider: OAuthProviderId,
  identity: Identity,
  ip: string,
  userAgent: string,
): Promise<NextResponse> {
  // link の開始者と**現セッションの user** が一致することだけを確認する。
  // state.user_id と user_id の照合は「state を消費した後のみ」だと意味が無いので、
  // ここで現セッションを直接見て user_id の一致を担保する（§7.8 T3'）。
  const token = getCookieToken(request);
  const session = token ? await getSession(token) : null;
  if (!session) throw new ApiError('SESSION_EXPIRED');

  const user = await findUserById(session.userId);
  if (!user) throw new ApiError('SESSION_EXPIRED');

  const outcome = await completeLink({ user, provider, identity });

  switch (outcome.kind) {
    case 'already_linked':
      throw new ApiError('ACCOUNT_ALREADY_LINKED');
    case 'linked_elsewhere':
      throw new ApiError('ACCOUNT_LINKED_ELSEWHERE');
    case 'email_conflict':
      throw new ApiError('EMAIL_CONFLICT');
    case 'not_linkable':
      throw new ApiError('ACCOUNT_NOT_LINKABLE');
    default:
      break;
  }

  await recordSecurityEvent('oauth_linked', user.id, ip, userAgent, { provider });
  return redirectToPath('/settings/connected-accounts');
}

function redirectToPath(path: string, headers: Record<string, string> = {}): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';
  return NextResponse.redirect(new URL(path, base), {
    status: 303,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}