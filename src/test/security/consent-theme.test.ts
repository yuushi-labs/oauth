// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createOidcHandler } from '../../../scripts/server';
import { getOidcProvider } from '@/lib/oidc/provider';
import { createSession } from '@/lib/auth/session';
import { hashPassword } from '@/lib/auth/password';
import { resetEnvCache } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { generateTestOidcKeys } from '../helpers/oidc-keys';
import { CookieJar, cleanupTestRows, freePort, httpRequest } from '../helpers/http';
import { createOidcClient } from '@/lib/oidc/clients';

/**
 * BUG-5: the consent screen is rendered by scripts/server.ts as a bare HTML string, so it never
 * received globals.css or the theme provider and stayed light-only. Assert that it now carries a
 * prefers-color-scheme dark block, and that the CSP relaxation is limited to style-src while
 * script-src stays 'none' through default-src.
 */
const uid = randomBytes(4).toString('hex');
const email = `theme-e2e-${uid}@example.com`;
const username = `theme_e2e_${uid}`;
const password = 'Consent-Theme-Strong-Pass-2026!';
const userId = `usr_consent_theme_${uid}`;

let server: Server;
let issuer: string;
let sessionToken: string;
let clientId: string;

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
  // The handler wraps provider.callback(), so it must be created once and reused.
  const handleOidc = createOidcHandler(provider);
  server = createServer((req, res) => {
    void handleOidc(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
    [userId, username, email, await hashPassword(password), DEFAULT_ROLE_ID],
  );
  const session = await createSession(userId, { headers: new Headers({ 'user-agent': 'ConsentTheme/1.0' }) });
  sessionToken = session.token;

  const client = await createOidcClient({
    name: '同意画面テーマ確認',
    operator: 'テスト運営者',
    clientType: 'confidential',
    redirectUris: [`${issuer}/callback`],
    scopes: ['openid', 'email'],
    webOrigins: [],
  }, { userId, ip: '203.0.113.30', userAgent: 'vitest-consent-theme' });
  clientId = client.clientId;
}, 60_000);

afterAll(async () => {
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [clientId] });
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function newJar(): CookieJar {
  const jar = new CookieJar();
  const name = process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session';
  jar.seed(name, sessionToken);
  return jar;
}

async function request(url: string, jar: CookieJar) {
  const result = await httpRequest(url, { cookie: jar.header() });
  jar.store(result.headers);
  return result;
}

/** Mirrors the browser: authorize → (redirects) → consent screen. */
async function fetchConsentPage(): Promise<{ status: number; body: string; headers: Headers }> {
  const jar = newJar();
  const authorize = new URL('/oauth2/authorize', issuer);
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', `${issuer}/callback`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email');
  authorize.searchParams.set('state', 'state-abc');
  authorize.searchParams.set('nonce', 'nonce-abc');
  authorize.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  authorize.searchParams.set('code_challenge_method', 'S256');

  let response = await request(authorize.toString(), jar);
  for (let hop = 0; hop < 6; hop += 1) {
    if (response.status === 200) return { status: response.status, body: response.body, headers: response.headers };
    const location = response.headers.get('location');
    if (response.status !== 303 || !location) break;
    response = await request(new URL(location, issuer).toString(), jar);
  }
  throw new Error(`consent screen was not reached (last status ${response.status})`);
}

describe('Security - consent screen honours the OS colour scheme (BUG-5)', () => {
  it('renders a prefers-color-scheme dark block and the shared style', async () => {
    const page = await fetchConsentPage();
    expect(page.status).toBe(200);
    expect(page.body).toContain('prefers-color-scheme:dark');
    expect(page.body).toContain('color-scheme:light dark');
    expect(page.body).toContain('サービス連携の確認');
  }, 60_000);

  it('CSP relaxes style-src only; script-src stays none through default-src', async () => {
    const page = await fetchConsentPage();
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
  }, 60_000);

  it('動的値は escapeHtml 済み（style 追加後も脚本が混入しない）', async () => {
    const page = await fetchConsentPage();
    expect(page.body).toContain('テスト運営者');
    expect(page.body).not.toMatch(/<script/i);
  }, 60_000);
});