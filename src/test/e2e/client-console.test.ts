// @ts-nocheck
import { randomBytes, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOidcHandler } from '../../../scripts/server';
import { getOidcProvider } from '@/lib/oidc/provider';
import { createSession } from '@/lib/auth/session';
import { hashPassword } from '@/lib/auth/password';
import { getEnv, resetEnvCache } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { generateTestOidcKeys } from '../helpers/oidc-keys';
import { CookieJar, cleanupTestRows, clearOidcRateLimits, freePort, httpRequest } from '../helpers/http';
import { createOidcClient, updateOidcClient } from '@/lib/oidc/clients';
import { connectionTestRedirectUri } from '@/lib/oidc/client-validation';
import { buildAuthorizeUrl, createClientTestState, readClientTestState, runConnectionTest } from '@/lib/oidc/client-test';

/**
 * End-to-end proof of the console connection test: a self-service client registered through the
 * management library is driven through consent, code exchange and UserInfo, which is exactly what
 * the 接続テスト button performs in the browser.
 */
const uid = randomBytes(4).toString('hex');
const email = `console-e2e-${uid}@example.com`;
const username = `console_e2e_${uid}`;
const password = 'Console-E2e-Strong-Pass-2026!';
const userId = `usr_console_e2e_${uid}`;

let server: Server;
let issuer: string;
let sessionCookie: string;
let sessionId: string;
let clientSecret: string;
let clientId: string;
let testRedirectUri: string;

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
    [userId, username, email, await hashPassword(password), DEFAULT_ROLE_ID],
  );
  const created = await createSession(userId, { headers: new Headers({ 'user-agent': 'vitest-console-e2e' }) });
  sessionCookie = `${process.env.NODE_ENV === 'production' ? '__Host-' : ''}auth_session=${created.token}`;
  sessionId = created.session.id;

  testRedirectUri = connectionTestRedirectUri(issuer);
  const client = await createOidcClient({
    name: 'Console E2E App',
    operator: 'Console E2E Operator',
    clientType: 'confidential',
    redirectUris: ['https://rp.example/callback'],
    scopes: ['openid', 'profile', 'email'],
    webOrigins: [],
  }, { userId, ip: '203.0.113.30', userAgent: 'vitest-console-e2e' });
  clientId = client.clientId;
  clientSecret = client.clientSecret;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await clearOidcRateLimits('127.0.0.1');
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [clientId] });
  await getPool().end();
});

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

function consentCsrf(uidValue: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET).update(`oidc-consent\0${uidValue}\0${sessionId}`).digest('base64url');
}

/** Mirrors the browser: authorize → consent screen → allow → redirect to the registered callback. */
async function authorizeThroughConsent(authorizeUrl: string): Promise<{ callback: URL; consentBody: string }> {
  const jar = newJar();
  let target = new URL(authorizeUrl);
  let response = await request(target.toString(), jar);

  let consentBody = '';
  for (let hop = 0; hop < 6; hop += 1) {
    if (response.status === 200) {
      consentBody = response.body;
      break;
    }
    const location = response.headers.get('location');
    if (response.status !== 303 || !location) throw new Error(`unexpected authorize response ${response.status}`);
    target = new URL(location, issuer);
    response = await request(target.toString(), jar);
  }
  if (!consentBody) throw new Error('consent screen was not reached');

  const uidValue = target.pathname.split('/').pop()!;
  response = await request(target.toString(), jar, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: consentCsrf(uidValue), decision: 'allow' }).toString(),
  });

  for (let hop = 0; hop < 6; hop += 1) {
    expect(response.status).toBe(303);
    const next = new URL(response.headers.get('location')!, issuer);
    if (next.origin + next.pathname === testRedirectUri) return { callback: next, consentBody };
    response = await request(next.toString(), jar);
  }
  throw new Error('authorization response never reached the registered callback');
}

describe('E2E - console connection test (real HTTP against the provider)', () => {
  it('exchanges a code and returns the user claims using the registered redirect URI and secret', async () => {
    // The owner adds the test redirect URI manually before testing (D-26-06).
    await updateOidcClient(clientId, {
      name: 'Console E2E App',
      operator: 'Console E2E Operator',
      redirectUris: ['https://rp.example/callback', testRedirectUri],
      scopes: ['openid', 'profile', 'email'],
      webOrigins: [],
    }, { userId, ip: '203.0.113.30', userAgent: 'vitest-console-e2e' });

    const { value, state } = createClientTestState({
      clientId,
      sessionId,
      redirectUri: testRedirectUri,
      scopes: ['openid', 'profile', 'email'],
      clientSecret,
    });
    const restored = readClientTestState(value, sessionId);
    expect(restored).not.toBeNull();

    const { callback, consentBody } = await authorizeThroughConsent(buildAuthorizeUrl(state, issuer));
    expect(consentBody).toContain('Console E2E Operator');
    // D-26-07: self-service clients always disclose their registrant on the consent screen.
    expect(consentBody).toContain(username);
    expect(callback.searchParams.get('state')).toBe(state.state);

    const result = await runConnectionTest({
      issuer,
      clientId,
      clientSecret,
      redirectUri: testRedirectUri,
      code: callback.searchParams.get('code')!,
      codeVerifier: restored!.codeVerifier,
    });

    expect(result.idTokenIssued).toBe(true);
    expect(result.tokenType).toBe('Bearer');
    expect(result.scopes).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
    expect(result.claims.sub).toMatch(/^sub_/u);
    expect(result.claims.email).toBe(email);
    // メール所有確認を廃止したため email_verified は常に false（D-40-06）。
    expect(result.claims.email_verified).toBe(false);
    expect(result.claims.preferred_username).toBe(username);
    expect(JSON.stringify(result)).not.toContain(clientSecret);
  }, 60_000);

  it('refuses to exchange a code presented by another client secret', async () => {
    await updateOidcClient(clientId, {
      name: 'Console E2E App',
      operator: 'Console E2E Operator',
      redirectUris: ['https://rp.example/callback', testRedirectUri],
      scopes: ['openid'],
      webOrigins: [],
    }, { userId, ip: '203.0.113.30', userAgent: 'vitest-console-e2e' });

    const { state } = createClientTestState({
      clientId,
      sessionId,
      redirectUri: testRedirectUri,
      scopes: ['openid'],
      clientSecret: `sec_${randomBytes(32).toString('base64url')}`,
    });
    const { callback } = await authorizeThroughConsent(buildAuthorizeUrl(state, issuer));

    await expect(runConnectionTest({
      issuer,
      clientId,
      clientSecret: `sec_${randomBytes(32).toString('base64url')}`,
      redirectUri: testRedirectUri,
      code: callback.searchParams.get('code')!,
      codeVerifier: state.codeVerifier,
    })).rejects.toThrow();
  }, 60_000);
});
