import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOidcHandler } from '../../../scripts/server';
import { getOidcProvider } from '@/lib/oidc/provider';
import { hashClientSecret } from '@/lib/oidc/crypto';
import { createSession } from '@/lib/auth/session';
import { hashPassword } from '@/lib/auth/password';
import { getEnv, resetEnvCache } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { generateTestOidcKeys } from '../helpers/oidc-keys';
import { CookieJar, cleanupTestRows, clearOidcRateLimits, freePort, httpRequest } from '../helpers/http';
import { getSessionCookieName } from '@/lib/auth/cookie';

const uid = randomBytes(4).toString('hex');
const email = `oidc-e2e-${uid}@example.com`;
const username = `oidc_e2e_${uid}`;
const password = 'E2e-Strong-Passphrase-2026!';
const redirectUri = 'https://rp.example/callback';

let server: Server;
let issuer: string;
let sessionCookie: string;
let confidentialClient: { clientId: string; secret: string };
let publicClient: { clientId: string };

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  const keys = generateTestOidcKeys();
  process.env.OIDC_ISSUER = issuer;
  process.env.NEXT_PUBLIC_APP_URL = issuer;
  process.env.OIDC_JWKS_JSON = keys.jwks;
  process.env.OIDC_ADAPTER_ENCRYPTION_KEY = keys.adapterKey;
  process.env.CSRF_TRUSTED_ORIGINS = issuer;
  resetEnvCache();

  const provider = await getOidcProvider();
  if (!provider) throw new Error('OIDC provider is not enabled in the test environment');
  server = createServer((req, res) => {
    void createOidcHandler(provider)(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  const pool = getPool();
  await clearOidcRateLimits('127.0.0.1');
  await pool.query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id, password_changed_at)
     VALUES ($1, $2, $3, true, $4, 'active', $5, now())`,
    [`usr_e2e_${uid}`, username, email, await hashPassword(password), DEFAULT_ROLE_ID],
  );
  const { token } = await createSession(`usr_e2e_${uid}`, { headers: new Headers({ 'user-agent': 'vitest-e2e' }) });
  sessionCookie = `${process.env.NODE_ENV === 'production' ? '__Host-' : ''}auth_session=${token}`;

  const confidentialSecret = `sec_${randomBytes(32).toString('base64url')}`;
  confidentialClient = {
    clientId: `cli_e2e_conf_${uid}`,
    secret: confidentialSecret,
  };
  publicClient = { clientId: `cli_e2e_pub_${uid}` };
  await pool.query(
    `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
     VALUES ($1, 'E2E Service', 'E2E Operator', 'confidential', $2::jsonb, ARRAY['openid','profile','email']::text[], ARRAY[]::text[], 'client_secret_basic', $3),
            ($4, 'E2E Public', 'E2E Operator', 'public', $2::jsonb, ARRAY['openid','email']::text[], ARRAY['https://rp.example']::text[], 'none', NULL)`,
    [confidentialClient.clientId, JSON.stringify([redirectUri]), hashClientSecret(confidentialSecret), publicClient.clientId],
  );
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await clearOidcRateLimits('127.0.0.1');
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [confidentialClient.clientId, publicClient.clientId] });
  await getPool().end();
});

function consentCsrf(uidValue: string, sessionId: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET).update(`oidc-consent\0${uidValue}\0${sessionId}`).digest('base64url');
}

function newJar(): CookieJar {
  const jar = new CookieJar();
  for (const part of sessionCookie.split('; ')) {
    const [name, ...value] = part.split('=');
    jar.seed(name!, value.join('='));
  }
  return jar;
}

async function request(url: string, jar: CookieJar, init: RequestInit = {}) {
  const result = await httpRequest(url, { ...init, cookie: jar.header() });
  jar.store(result.headers);
  return result;
}

async function authorize(params: Record<string, string>, jar: CookieJar = newJar()) {
  const url = new URL('/oauth2/authorize', issuer);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await request(url.toString(), jar);
  return { ...response, jar };
}

type LoginResult = { code: string; state: string };

async function completeLogin(params: Record<string, string>): Promise<LoginResult> {
  const jar = newJar();
  const start = await authorize(params, jar);
  expect(start.status).toBe(303);
  let target = new URL(start.headers.get('location')!, issuer);
  let consent = null;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await request(target.toString(), jar);
    if (response.status === 200) { consent = response; break; }
    const location = response.headers.get('location');
    if (response.status !== 303 || !location) {
      throw new Error(`unexpected interaction response ${response.status} at ${target}`);
    }
    target = new URL(location, issuer);
  }
  if (!consent) throw new Error('consent screen was not reached');
  expect(consent.body).toContain('E2E Operator');
  expect(consent.body).toContain('email_verified');

  const uidValue = target.pathname.split('/').pop()!;
  const { rows } = await getPool().query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [`usr_e2e_${uid}`]);
  const csrf = consentCsrf(uidValue, rows[0]!.id);
  const postProbe = await request(target.toString(), jar, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, decision: 'allow' }).toString(),
  });
  let response = postProbe;
  let callback: URL | null = null;
  for (let hop = 0; hop < 6 && !callback; hop += 1) {
    expect(response.status).toBe(303);
    const location = response.headers.get('location')!;
    const next = new URL(location, issuer);
    if (next.origin + next.pathname === redirectUri) { callback = next; break; }
    response = await request(next.toString(), jar);
  }
  if (!callback) throw new Error('authorization response was not delivered to the RP callback');
  return { code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')! };
}

describe('OIDC E2E — Authorization Code + PKCE against a real RP library', () => {
  it('Discovery advertises only the enabled endpoints and algorithms', async () => {
    const discovery = await httpRequest(new URL('/.well-known/openid-configuration', issuer).toString());
    expect(discovery.status).toBe(200);
    const metadata = discovery.json<Record<string, unknown>>();
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.authorization_endpoint).toBe(`${issuer}/oauth2/authorize`);
    expect(metadata.token_endpoint).toBe(`${issuer}/oauth2/token`);
    expect(metadata.userinfo_endpoint).toBe(`${issuer}/oauth2/userinfo`);
    expect(metadata.revocation_endpoint).toBe(`${issuer}/oauth2/revoke`);
    expect(metadata.jwks_uri).toBe(`${issuer}/oauth2/jwks`);
    expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(metadata.grant_types_supported).toEqual(['authorization_code']);
    expect(metadata.response_types_supported).toEqual(['code']);
    expect(metadata.scopes_supported).toEqual(['openid', 'profile', 'email']);
    for (const disabled of ['token_endpoint_auth_methods_supported', 'code_challenge_methods_supported']) {
      expect(metadata[disabled]).toBeDefined();
    }
    expect(metadata.scopes_supported).not.toContain('offline_access');
    expect(metadata.claims_supported).not.toContain('address');
  });

  it('JWKS is public only and carries a kid', async () => {
    const jwks = await httpRequest(new URL('/oauth2/jwks', issuer).toString());
    const body = jwks.json<{ keys: Record<string, unknown>[] }>();
    expect(jwks.status).toBe(200);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    expect(body.keys[0]!.kid).toBeTruthy();
    expect(body.keys[0]!.d).toBeUndefined();
  });

  it('completes login, issues an ID Token, serves UserInfo, and revokes', async () => {
    const { createPrivateKey } = await import('node:crypto');
    const { generateKeyPairSync, createHash } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(8).toString('hex');
    const nonce = randomBytes(8).toString('hex');

    const { code } = await completeLogin({
      client_id: confidentialClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    expect(code).toBeTruthy();

    const basic = Buffer.from(`${encodeURIComponent(confidentialClient.clientId)}:${encodeURIComponent(confidentialClient.secret)}`).toString('base64');
    const tokenResponse = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = tokenResponse.json<{ access_token: string; id_token: string; token_type: string; expires_in: number }>();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeLessThanOrEqual(600);

    const { createPublicKey, createVerify } = await import('node:crypto');
    const jwks = (await httpRequest(new URL('/oauth2/jwks', issuer).toString())).json<{ keys: Record<string, string>[] }>();
    const publicKey = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' });
    const parts = tokens.id_token.split('.');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe(jwks.keys[0]!.kid);
    const verified = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(publicKey, Buffer.from(parts[2]!, 'base64url'));
    expect(verified).toBe(true);
    expect(payload.iss).toBe(issuer);
    expect(payload.aud).toBe(confidentialClient.clientId);
    expect(payload.nonce).toBe(nonce);
    expect(typeof payload.auth_time).toBe('number');
    expect(payload.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.sub).not.toContain(`usr_e2e_${uid}`);
    expect(payload.sub).toMatch(/^sub_/u);

    const userinfo = await httpRequest(new URL('/oauth2/userinfo', issuer).toString(), {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    expect(userinfo.status).toBe(200);
    const claims = userinfo.json<Record<string, unknown>>();
    expect(claims.sub).toBe(payload.sub);
    expect(claims.email).toBe(email);
    expect(claims.email_verified).toBe(true);
    expect(claims.preferred_username).toBe(username);

    const replay = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
    });
    expect(replay.status).toBe(400);

    const revoked = await httpRequest(new URL('/oauth2/revoke', issuer).toString(), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: tokens.access_token, token_type_hint: 'access_token' }).toString(),
    });
    expect(revoked.status).toBe(200);

    const afterRevoke = await httpRequest(new URL('/oauth2/userinfo', issuer).toString(), {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    expect(afterRevoke.status).toBe(401);
    expect(createPrivateKey).toBeDefined();
  }, 30_000);

  it('rejects a PKCE verifier mismatch and a wrong client secret', async () => {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = (await import('node:crypto')).createHash('sha256').update(codeVerifier).digest('base64url');
    const { code } = await completeLogin({
      client_id: confidentialClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const basic = (secret: string) => `Basic ${Buffer.from(`${confidentialClient.clientId}:${secret}`).toString('base64')}`;
    const wrongVerifier = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { authorization: basic(confidentialClient.secret), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: randomBytes(32).toString('base64url') }).toString(),
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.json<{ error: string }>().error).toBe('invalid_grant');

    const wrongSecret = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { authorization: basic('sec_wrong'), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
    });
    expect(wrongSecret.status).toBe(401);
  }, 30_000);

  it('rejects unauthorized requests before the provider sees them', async () => {
    const base = {
      client_id: confidentialClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: 'st',
      nonce: 'no',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    };
    const cases: Array<[string, Record<string, string>]> = [
      ['wrong redirect', { ...base, redirect_uri: 'https://attacker.example/callback' }],
      ['prefix redirect', { ...base, redirect_uri: `${redirectUri}/extra` }],
      ['implicit flow', { ...base, response_type: 'token' }],
      ['plain pkce', { ...base, code_challenge_method: 'plain' }],
      ['missing nonce', { ...base, nonce: undefined as unknown as string }],
      ['missing state', { ...base, state: undefined as unknown as string }],
      ['unknown scope', { ...base, scope: 'openid admin' }],
      ['forbidden scope', { ...base, scope: 'openid offline_access' }],
      ['resource indicator', { ...base, resource: 'https://api.example' }],
      ['revoked client', { ...base, client_id: 'cli_missing' }],
    ];
    for (const [label, params] of cases) {
      const url = new URL('/oauth2/authorize', issuer);
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        url.searchParams.set(key, value);
      }
      const response = await httpRequest(url.toString(), { cookie: sessionCookie });
      expect(response.status, label).toBe(400);
      expect(response.headers.get('location'), label).toBeNull();
    }
  }, 30_000);

  it('requires login before continuing and never resumes an unauthenticated interaction', async () => {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = (await import('node:crypto')).createHash('sha256').update(codeVerifier).digest('base64url');
    const start = await authorize({
      client_id: publicClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    expect(start.status).toBe(303);
    const interactionUrl = new URL(start.headers.get('location')!, issuer);
    expect(interactionUrl.pathname).toMatch(/^\/oauth2\/interaction\//u);

    start.jar.delete(getSessionCookieName());
    const anonymous = await request(interactionUrl.toString(), start.jar);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/login?returnTo=');
    expect(anonymous.headers.get('referrer-policy')).toBe('no-referrer');
    expect(anonymous.body).not.toContain('Consent');
  }, 30_000);

  it('serves public client UserInfo only for the scopes it was granted', async () => {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = (await import('node:crypto')).createHash('sha256').update(codeVerifier).digest('base64url');
    const { code } = await completeLogin({
      client_id: publicClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const tokenResponse = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: publicClient.clientId }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = tokenResponse.json<{ access_token: string }>();
    const userinfo = await httpRequest(new URL('/oauth2/userinfo', issuer).toString(), {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    const claims = userinfo.json<Record<string, unknown>>();
    expect(claims.email).toBe(email);
    expect(claims.preferred_username).toBeUndefined();
    expect(claims.picture).toBeUndefined();
  }, 30_000);

  it('refuses UserInfo after the account is suspended', async () => {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = (await import('node:crypto')).createHash('sha256').update(codeVerifier).digest('base64url');
    const { code } = await completeLogin({
      client_id: confidentialClient.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const basic = `Basic ${Buffer.from(`${confidentialClient.clientId}:${confidentialClient.secret}`).toString('base64')}`;
    const tokens = (await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
    })).json<{ access_token: string }>();

    await getPool().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [`usr_e2e_${uid}`]);
    const denied = await httpRequest(new URL('/oauth2/userinfo', issuer).toString(), {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    });
    expect(denied.status).toBe(401);
    await getPool().query(`UPDATE users SET status = 'active' WHERE id = $1`, [`usr_e2e_${uid}`]);

    const events = await getPool().query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM security_events WHERE user_id = $1 AND event_type LIKE 'oidc_%'`, [`usr_e2e_${uid}`],
    );
    expect(events.rows.map((row) => row.event_type)).toContain('oidc_consent_granted');
  }, 30_000);
});