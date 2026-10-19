import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ProviderError } from './provider-error';
import type { OAuthProviderEntry } from './types';

/**
 * Google（OIDC / 署名検証つき）。
 *
 * - ID token は `jose` で検証する。**alg を RS256 に固定**し、alg=none や HS256 を弾く（D-31-04）。
 * - `aud` は client_id、`iss` は 2 形式、`nonce` は state に保存した値と照合する。
 * - profile は ID token の claims から取る（userinfo を叩かない。access_token を持ち出さない）。
 */
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** Google は ID token の `iss` をどちらの形式でも返しうるため両方受理する。 */
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export const google: OAuthProviderEntry = {
  id: 'google',
  label: 'Google',
  protocol: 'oidc',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  envKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  isConfigured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),

  async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      cache: 'no-store',
    });
    if (!response.ok) throw new ProviderError('token_exchange_failed');
    const json = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
    };
    if (!json.access_token || json.error) throw new ProviderError('token_exchange_failed');
    return {
      accessToken: json.access_token,
      idToken: json.id_token,
      tokenType: json.token_type ?? 'Bearer',
      scope: json.scope,
    };
  },

  async verifyIdToken({ idToken, nonce, clientId }) {
    const { payload } = await jwtVerify(idToken, JWKS, {
      algorithms: ['RS256'],
      audience: clientId,
      issuer: ISSUERS,
      clockTolerance: 5,
    });
    // nonce を照合する（OIDC 必須）。state だけ検証して nonce を落とすと
    // 同一 ID token の使い回しが通ってしまう。
    if (payload.nonce !== nonce) throw new ProviderError('nonce_mismatch');
    return payload as Record<string, unknown>;
  },

  async fetchIdentity({ idTokenClaims }) {
    const email = typeof idTokenClaims?.email === 'string' ? idTokenClaims.email : null;
    const sub = typeof idTokenClaims?.sub === 'string' ? idTokenClaims.sub : null;
    if (!sub) throw new ProviderError('id_token_invalid');
    return {
      providerAccountId: sub,
      email: email && email.length > 0 ? email : null,
      emailVerified: idTokenClaims?.email_verified === true,
      displayName: typeof idTokenClaims?.name === 'string' ? idTokenClaims.name : null,
    };
  },
};