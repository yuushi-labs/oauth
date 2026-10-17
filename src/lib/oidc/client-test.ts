import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { decryptOidcValue, encryptOidcValue } from '@/lib/oidc/crypto';
import { ApiError } from '@/lib/errors';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const SIGNATURE_CONTEXT = 'oidc-client-test-state-v1';

export type ClientTestState = {
  clientId: string;
  sessionId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Encrypted plaintext client secret, only present for confidential clients. */
  encryptedSecret: string | null;
  expiresAt: number;
};

export function getClientTestCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-auth_oidc_test' : 'auth_oidc_test';
}

function sign(payload: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET).update(`${SIGNATURE_CONTEXT}\0${payload}`).digest('base64url');
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function codeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function createClientTestState(input: {
  clientId: string;
  sessionId: string;
  redirectUri: string;
  scopes: readonly string[];
  clientSecret: string | null;
}): { value: string; state: ClientTestState } {
  const state: ClientTestState = {
    clientId: input.clientId,
    sessionId: input.sessionId,
    redirectUri: input.redirectUri,
    scopes: [...input.scopes],
    state: base64Url(randomBytes(24)),
    nonce: base64Url(randomBytes(24)),
    codeVerifier: base64Url(randomBytes(32)),
    encryptedSecret: input.clientSecret ? encryptOidcValue(input.clientSecret) : null,
    expiresAt: Date.now() + STATE_MAX_AGE_MS,
  };
  const payload = JSON.stringify(state);
  return { value: `${base64Url(Buffer.from(payload, 'utf8'))}.${sign(payload)}`, state };
}

export function readClientTestState(cookieValue: string | undefined, sessionId: string): ClientTestState | null {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf('.');
  if (dot < 0) return null;
  const encoded = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = Buffer.from(sign(payload), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: ClientTestState;
  try {
    parsed = JSON.parse(payload) as ClientTestState;
  } catch {
    return null;
  }
  if (parsed.sessionId !== sessionId) return null;
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt < Date.now()) return null;
  return parsed;
}

export function buildAuthorizeUrl(state: ClientTestState, issuer: string): string {
  const url = new URL('/oauth2/authorize', issuer);
  url.searchParams.set('client_id', state.clientId);
  url.searchParams.set('redirect_uri', state.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', state.scopes.join(' '));
  url.searchParams.set('code_challenge', codeChallenge(state.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state.state);
  url.searchParams.set('nonce', state.nonce);
  return url.toString();
}

export type ConnectionTestResult = {
  scopes: string[];
  expiresIn: number | null;
  tokenType: string | null;
  idTokenIssued: boolean;
  claims: Record<string, unknown>;
};

type TokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
};

/**
 * Runs the client's own Authorization Code + PKCE exchange against this provider. The plaintext
 * secret is supplied by the owner and never persisted: it is encrypted into the short-lived,
 * HttpOnly state cookie and used only here.
 */
export async function runConnectionTest(input: {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<ConnectionTestResult> {
  const { issuer, clientId, clientSecret, redirectUri, code, codeVerifier } = input;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
  }

  const tokenResponse = await fetch(new URL('/oauth2/token', issuer), {
    method: 'POST',
    headers,
    body: form.toString(),
    cache: 'no-store',
  });
  const tokenBody = (await tokenResponse.json().catch(() => null)) as TokenResponse | { error?: unknown; error_description?: unknown } | null;
  if (!tokenResponse.ok || !tokenBody || typeof tokenBody !== 'object' || typeof (tokenBody as TokenResponse).access_token !== 'string') {
    const description = (tokenBody as { error_description?: unknown } | null)?.error_description;
    throw new ApiError('INVALID_CODE', typeof description === 'string' ? description : '認証コードの交換に失敗しました');
  }
  const tokens = tokenBody as TokenResponse;
  const accessToken = tokens.access_token as string;

  const userInfoResponse = await fetch(new URL('/oauth2/userinfo', issuer), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  const claims = (await userInfoResponse.json().catch(() => null)) as Record<string, unknown> | null;
  if (!userInfoResponse.ok || !claims) {
    throw new ApiError('INVALID_CODE', 'ユーザー情報を取得できませんでした');
  }

  return {
    scopes: typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter(Boolean) : [],
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    tokenType: typeof tokens.token_type === 'string' ? tokens.token_type : null,
    idTokenIssued: typeof tokens.id_token === 'string',
    claims,
  };
}

export function decryptClientTestSecret(state: ClientTestState): string | null {
  if (!state.encryptedSecret) return null;
  try {
    return decryptOidcValue(state.encryptedSecret);
  } catch {
    return null;
  }
}
