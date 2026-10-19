import { ProviderError } from './provider-error';
import type { OAuthProviderEntry } from './types';

/**
 * Discord（OAuth2 / ID token は無い）。
 *
 * - email は `/users/@me` の `email` を使うが、**`verified === true` のときだけ**採用する（§11.2 / D-11）。
 * - scope に `email` を入れていても、ユーザーがメール非公開にしていれば `email` は null になる。
 *   null と空文字を区別して扱わないと「検証済みの空メール」で登録できてしまう（D-31-08）。
 */
export const discord: OAuthProviderEntry = {
  id: 'discord',
  label: 'Discord',
  protocol: 'oauth2',
  authorizationEndpoint: 'https://discord.com/oauth2/authorize',
  tokenEndpoint: 'https://discord.com/api/oauth2/token',
  scope: 'identify email',
  envKeys: { clientId: 'DISCORD_CLIENT_ID', clientSecret: 'DISCORD_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
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
    return { accessToken: json.access_token, tokenType: json.token_type ?? 'Bearer', scope: json.scope };
  },

  async fetchIdentity({ accessToken }) {
    const response = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new ProviderError('userinfo_failed');

    const me = (await response.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      email?: string | null;
      verified?: boolean;
    };
    if (typeof me.id !== 'string' || me.id.length === 0) throw new ProviderError('userinfo_failed');

    const email = typeof me.email === 'string' && me.email.length > 0 ? me.email : null;
    return {
      providerAccountId: me.id,
      email,
      emailVerified: me.verified === true && email !== null,
      displayName: me.global_name ?? me.username ?? null,
    };
  },
};