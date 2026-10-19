import { ProviderError } from './provider-error';
import type { OAuthProviderEntry } from './types';

/**
 * GitHub（OAuth2 / ID token は無い）。
 *
 * - **token 交換・API 呼び出しの両方で `Accept: application/json` を送る**（D-31-03）。
 *   GitHub は既定で `x-www-form-urlencoded` を返すため、これが無いと `res.json()` が例外になる。
 * - email は `/user` ではなく `/user/emails` から **`primary && verified`** を採用する（§11.2 / D-10）。
 *   その組が無いユーザー（＝メールを非公開にしているユーザー）は email=null となり、
 *   新規登録させない（D-31-08）。
 */
export const github: OAuthProviderEntry = {
  id: 'github',
  label: 'GitHub',
  protocol: 'oauth2',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  scope: 'read:user user:email',
  envKeys: { clientId: 'GITHUB_CLIENT_ID', clientSecret: 'GITHUB_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      cache: 'no-store',
    });
    if (!response.ok) throw new ProviderError('token_exchange_failed');
    const json = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
    };
    if (json.error || !json.access_token) throw new ProviderError('token_exchange_failed');
    return { accessToken: json.access_token, tokenType: json.token_type ?? 'bearer', scope: json.scope };
  },

  async fetchIdentity({ accessToken }) {
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'x-github-api-version': '2022-11-28',
    };
    const [userResponse, emailsResponse] = await Promise.all([
      fetch('https://api.github.com/user', { headers, cache: 'no-store' }),
      fetch('https://api.github.com/user/emails', { headers, cache: 'no-store' }),
    ]);
    if (!userResponse.ok || !emailsResponse.ok) throw new ProviderError('userinfo_failed');

    const user = (await userResponse.json()) as { id?: number | string; name?: string | null; login?: string | null };
    const emails = (await emailsResponse.json()) as Array<{
      email?: string;
      primary?: boolean;
      verified?: boolean;
    }>;

    if (user.id === undefined || user.id === null) throw new ProviderError('userinfo_failed');

    const chosen = emails.find((entry) => entry.primary === true && entry.verified === true) ?? null;
    const email = typeof chosen?.email === 'string' && chosen.email.length > 0 ? chosen.email : null;

    return {
      providerAccountId: String(user.id),
      email,
      // primary && verified の組が採れなかった = 検証済みの email が無い = 検証不合格（D-31-08）
      emailVerified: email !== null,
      displayName: user.name ?? user.login ?? null,
    };
  },
};