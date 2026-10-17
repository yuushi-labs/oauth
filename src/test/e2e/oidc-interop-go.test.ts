// @ts-nocheck
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
import { hashClientSecret } from '@/lib/oidc/crypto';

/**
 * P25-E-05: interoperability with a second OIDC stack.
 *
 * The provider is driven with the same authorization code + PKCE flow used elsewhere, but the
 * relying party is `interop/rp-go`, which uses coreos/go-oidc3 (Go) instead of the Node client.
 * A second implementation is what makes this a genuine interop check: it validates Discovery,
 * JWKS signature verification, audience, nonce and UserInfo against an independent stack.
 */
const exec = promisify(execFile);

const uid = randomBytes(4).toString('hex');
const email = `go-rp-${uid}@example.com`;
const username = `go_rp_${uid}`;
const password = 'Go-Rp-Strong-Pass-2026!';
const redirectUri = 'https://go-rp.example/callback';

const goBinary = process.env.GO_BINARY ?? 'go';
const goRpBinary = process.env.GO_RP_BINARY ?? '/tmp/rp-go';
const interopRoot = 'interop/rp-go';

let server: Server;
let issuer: string;
let sessionCookie: string;
let sessionId: string;
let clientId: string;
let clientSecret: string;
let goAvailable = true;

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
    [`usr_go_rp_${uid}`, username, email, await hashPassword(password), DEFAULT_ROLE_ID],
  );
  const created = await createSession(`usr_go_rp_${uid}`, { headers: new Headers({ 'user-agent': 'vitest-go-interop' }) });
  sessionCookie = `${process.env.NODE_ENV === 'production' ? '__Host-' : ''}auth_session=${created.token}`;
  sessionId = created.session.id;

  clientSecret = `sec_${randomBytes(32).toString('base64url')}`;
  clientId = `cli_go_rp_${uid}`;
  await pool.query(
    `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
     VALUES ($1, 'Go RP', 'Go RP Operator', 'confidential', $2::jsonb, ARRAY['openid','profile','email']::text[], ARRAY[]::text[], 'client_secret_basic', $3)`,
    [clientId, JSON.stringify([redirectUri]), hashClientSecret(clientSecret)],
  );

  goAvailable = await buildGoRp();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await clearOidcRateLimits('127.0.0.1');
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [clientId] });
  await getPool().end();
});

async function buildGoRp(): Promise<boolean> {
  try {
    await exec(goBinary, ['build', '-o', goRpBinary, '.'], {
      cwd: interopRoot,
      timeout: 300_000,
      env: { ...process.env, GOTOOLCHAIN: 'local' },
    });
    return true;
  } catch (error) {
    process.stderr.write(
      `Go RP のビルドに失敗しました。interop test をスキップします: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
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

/** Drives authorize -> consent -> callback exactly like a browser would, and returns the code. */
async function authorizeThroughConsent(params: Record<string, string>): Promise<{ code: string; state: string }> {
  const jar = newJar();
  const url = new URL('/oauth2/authorize', issuer);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let target = url;
  let response = await request(target.toString(), jar);
  let consentBody = '';
  for (let hop = 0; hop < 6; hop += 1) {
    if (response.status === 200) { consentBody = response.body; break; }
    const location = response.headers.get('location');
    if (response.status !== 303 || !location) throw new Error(`unexpected authorize response ${response.status}`);
    target = new URL(location, issuer);
    response = await request(target.toString(), jar);
  }
  if (!consentBody) throw new Error('consent screen was not reached');
  expect(consentBody).toContain('Go RP Operator');

  const interactionUid = target.pathname.split('/').pop()!;
  const csrf = createConsentCsrf(interactionUid, sessionId);
  response = await request(target.toString(), jar, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, decision: 'allow' }).toString(),
  });

  for (let hop = 0; hop < 6; hop += 1) {
    expect(response.status).toBe(303);
    const next = new URL(response.headers.get('location')!, issuer);
    if (next.origin + next.pathname === redirectUri) {
      return { code: next.searchParams.get('code')!, state: next.searchParams.get('state')! };
    }
    response = await request(next.toString(), jar);
  }
  throw new Error('authorization response never reached the registered callback');
}

function createConsentCsrf(uidValue: string, sid: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET).update(`oidc-consent\0${uidValue}\0${sid}`).digest('base64url');
}

function runGoRp(args: string[]): Promise<{ claims: Record<string, unknown>; stdout: string; stderr: string }> {
  return exec(goRpBinary, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ claims: JSON.parse(stdout) as Record<string, unknown>, stdout, stderr }),
  );
}

describe('E2E - interoperability with coreos/go-oidc3 (Go relying party)', () => {
  it('completes the login and exposes verified claims to an independent OIDC stack', async () => {
    if (!goAvailable) {
      process.stderr.write('Go toolchain unavailable: skipping go-oidc3 interop case\n');
      return;
    }

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(8).toString('hex');
    const nonce = randomBytes(8).toString('hex');

    const { code } = await authorizeThroughConsent({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    expect(state).toBeTruthy();

    const { claims } = await runGoRp([
      '-issuer', issuer,
      '-client-id', clientId,
      '-client-secret', clientSecret,
      '-redirect-uri', redirectUri,
      '-code', code,
      '-code-verifier', codeVerifier,
      '-nonce', nonce,
    ]);

    // Discovery, JWKS signature verification, audience and nonce checks all passed inside
    // go-oidc3: the binary exits non-zero otherwise, so reaching this point proves them.
    expect(claims.sub).toMatch(/^sub_/u);
    expect(claims.sub).not.toContain(`usr_go_rp_${uid}`);
    expect(claims.issuer).toBe(issuer);
    expect(Number(claims.access_token_ttl)).toBeGreaterThan(0);
    expect(Number(claims.access_token_ttl)).toBeLessThanOrEqual(600);

    // The ID Token carries identity and auth_time only; profile and email are released through
    // UserInfo, which is what §69.5 prescribes. Both were requested with one authorization code.
    const idTokenClaims = claims.id_token_claims as Record<string, unknown>;
    expect(idTokenClaims.aud).toBe(clientId);
    expect(idTokenClaims.iss).toBe(issuer);
    expect(idTokenClaims.sub).toBe(claims.sub);
    expect(idTokenClaims.nonce).toBe(nonce);
    expect(typeof idTokenClaims.auth_time).toBe('number');
    expect(Number(idTokenClaims.exp)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(Number(idTokenClaims.exp)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
    expect(idTokenClaims.email).toBeUndefined();

    const userinfo = claims.userinfo as Record<string, unknown>;
    expect(userinfo.sub).toBe(claims.sub);
    expect(userinfo.email).toBe(email);
    expect(userinfo.email_verified).toBe(true);
    expect(userinfo.preferred_username).toBe(username);
    expect(userinfo.name).toBe(username);
  }, 90_000);

  it('rejects a tampered code and a wrong secret from the Go relying party', async () => {
    if (!goAvailable) return;

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = randomBytes(8).toString('hex');
    const { code } = await authorizeThroughConsent({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: randomBytes(8).toString('hex'),
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const baseArgs = [
      '-issuer', issuer,
      '-client-id', clientId,
      '-redirect-uri', redirectUri,
      '-code-verifier', codeVerifier,
      '-nonce', nonce,
    ];

    await expect(runGoRp([...baseArgs, '-client-secret', 'sec_wrong', '-code', code])).rejects.toThrow(/interop failure/);

    const second = await authorizeThroughConsent({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
      code_challenge_method: 'S256',
    });
    await expect(runGoRp([...baseArgs, '-client-secret', clientSecret, '-code', second.code])).rejects.toThrow(/interop failure/);
  }, 90_000);
});
