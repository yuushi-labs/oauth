// @ts-nocheck
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestAppServer } from '../helpers/app-server';
import { CookieJar, cleanupTestRows, freePort, httpRequest } from '../helpers/http';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';

/**
 * 実 HTTP に対する画面と認証フローの検証（DoD の login / register / theme / sessions）。
 *
 * Playwright は Phase 8-B までは使わない（D-30-01）。そのため viewport 依存の検証は
 * 行わず、**SSR HTML・Cookie・303・リダイレクト・ヘッダ**を実 HTTP で確認する。
 */
const uid = randomBytes(4).toString('hex');
const email = `phase3-e2e-${uid}@example.com`;
const username = `phase3_e2e_${uid}`;
const password = 'Phase3-E2E-Strong-Pass-2026!';
const userId = `usr_phase3_e2e_${uid}`;

let app: Awaited<ReturnType<typeof startTestAppServer>>;
let jars: CookieJar[] = [];

function jar(): CookieJar {
  const created = new CookieJar();
  jars.push(created);
  return created;
}

async function csrfFor(cookieJar: CookieJar): Promise<string> {
  const response = await httpRequest(`${app.origin}/api/auth/csrf`, { cookie: cookieJar.header() });
  cookieJar.store(response.headers);
  const body = response.json<{ data: { csrfToken: string } }>();
  return body.data.csrfToken;
}

beforeAll(async () => {
  app = await startTestAppServer({ dev: true, oidc: true });
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
    [userId, username, email, await hashPassword(password), DEFAULT_ROLE_ID],
  );
}, 120_000);

afterEach(() => {
  jars = [];
});

afterAll(async () => {
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [] });
  if (app) await app.stop();
}, 60_000);

describe('E2E - login / register screens', () => {
  it('/login は 200 で label と autocomplete を持つ', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.status).toBe(200);
    // React の SSR は autoComplete（大文字Camel）で出力する
    expect(response.body).toContain('<label');
    expect(response.body).toContain('autoComplete="username"');
    expect(response.body).toContain('autoComplete="current-password"');
    expect(response.headers.get('cache-control')).toContain('no-store');
  }, 60_000);

  it('/register は 200 で PW meter（progressbar）と 8〜128 の制限を持つ', async () => {
    const response = await httpRequest(`${app.origin}/register`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('role="progressbar"');
    expect(response.body).toContain('minLength="8"');
    expect(response.body).toContain('maxLength="128"');
  }, 60_000);

  it('テーマ切替 UI（3 択）が描画され、社会ログインボタンは registry 設定時だけ出る', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.body).toContain('システムに追従');
    expect(response.body).toContain('ライト');
    expect(response.body).toContain('ダーク');

    // Phase 4 で registry にエントリが入ったので、設定されていればボタンが出る。
    // 「Google で続行」は registry が空のときだけ出ない（D-30-21）。
    const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    if (googleConfigured) {
      expect(response.body).toContain('Google で続行');
      expect(response.body).toContain('/api/auth/oauth/google');
    } else {
      expect(response.body).not.toContain('Google で続行');
    }
  }, 60_000);

  it('未ログインの /settings/* は /login へリダイレクトされる', async () => {
    for (const path of ['/settings', '/settings/security', '/settings/sessions', '/settings/appearance', '/settings/password']) {
      const response = await httpRequest(`${app.origin}${path}`);
      expect([302, 307, 303], `${path} はガードでリダイレクトされる`).toContain(response.status);
      expect(response.headers.get('location')).toContain('/login');
    }
  }, 60_000);

  it('壊れた CSRF トークンは 403（サーバ側で拒否される）', async () => {
    const cookieJar = jar();
    const response = await httpRequest(`${app.origin}/api/auth/password/forgot`, {
      method: 'POST',
      cookie: cookieJar.header(),
      headers: { 'content-type': 'application/json', origin: app.origin, 'x-csrf-token': 'wrong-token' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(response.status).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CSRF_FAILED');
  }, 60_000);
});

describe('E2E - theme persistence', () => {
  it('ログイン後、theme が保存され FOUC script に server 値が現れる', async () => {
    const cookieJar = jar();
    const session = await createSession(userId, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36' }),
    });
    cookieJar.seed(
      process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session',
      session.token,
    );

    const token = await csrfFor(cookieJar);
    const patched = await httpRequest(`${app.origin}/api/auth/preferences`, {
      method: 'PATCH',
      cookie: cookieJar.header(),
      headers: { 'content-type': 'application/json', origin: app.origin, 'x-csrf-token': token },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.json<{ data: { theme: string } }>().data.theme).toBe('dark');

    const page = await httpRequest(`${app.origin}/settings/appearance`, { cookie: cookieJar.header() });
    expect(page.status).toBe(200);
    // FOUC 防止 script にサーバーが渡した値（dark）が含まれる
    expect(page.body).toContain('var s="dark"');

    const fetched = await httpRequest(`${app.origin}/api/auth/preferences`, { cookie: cookieJar.header() });
    expect(fetched.json<{ data: { theme: string } }>().data.theme).toBe('dark');

    const stored = await getUserPreferences(userId);
    expect(stored.theme).toBe('dark');
  }, 90_000);
});

describe('E2E - session management', () => {
  it('2 セッションを認識し、個別ログアウトと全ログアウトが効く', async () => {
    const first = jar();
    const firstSession = await createSession(userId, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36' }),
    });
    first.seed(process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session', firstSession.token);

    const second = jar();
    const secondSession = await createSession(userId, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }),
    });
    second.seed(process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session', secondSession.token);

    const listed = await httpRequest(`${app.origin}/api/auth/sessions`, { cookie: first.header() });
    expect(listed.status).toBe(200);
    const sessions = listed.json<{ data: { sessions: { id: string; current: boolean; device_name: string }[] } }>().data.sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]!.current).toBe(true);
    expect(sessions.some((row) => row.device_name === 'iPhone')).toBe(true);

    // 他人のセッションに相当する ID（存在しない）は 404
    const missing = await httpRequest(`${app.origin}/api/auth/sessions/ses_does_not_exist`, {
      method: 'DELETE',
      cookie: first.header(),
      headers: { origin: app.origin, 'x-csrf-token': await csrfFor(first) },
    });
    expect(missing.status).toBe(404);

    // 自分のセッションを 1 つ失効
    const target = sessions.find((row) => !row.current)!;
    const deleted = await httpRequest(`${app.origin}/api/auth/sessions/${target.id}`, {
      method: 'DELETE',
      cookie: first.header(),
      headers: { origin: app.origin, 'x-csrf-token': await csrfFor(first) },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json<{ data: { revoked: boolean } }>().data.revoked).toBe(true);

    // 失効したセッションの Cookie は拒否される
    const revokedCheck = await httpRequest(`${app.origin}/api/auth/me`, { cookie: second.header() });
    expect(revokedCheck.status).toBe(401);
  }, 120_000);

  it('全ログアウトは再認証なしでは拒否される', async () => {
    const cookieJar = jar();
    const created = await createSession(userId, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36' }),
    });
    cookieJar.seed(process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session', created.token);

    const denied = await httpRequest(`${app.origin}/api/auth/logout-all`, {
      method: 'POST',
      cookie: cookieJar.header(),
      headers: { origin: app.origin, 'x-csrf-token': await csrfFor(cookieJar) },
    });
    expect(denied.status).toBe(401);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('REAUTH_REQUIRED');

    const token = await csrfFor(cookieJar);
    const reauth = await httpRequest(`${app.origin}/api/auth/reauth`, {
      method: 'POST',
      cookie: cookieJar.header(),
      headers: { 'content-type': 'application/json', origin: app.origin, 'x-csrf-token': token },
      body: JSON.stringify({ password }),
    });
    expect(reauth.status).toBe(200);

    const loggedOut = await httpRequest(`${app.origin}/api/auth/logout-all`, {
      method: 'POST',
      cookie: cookieJar.header(),
      headers: { origin: app.origin, 'x-csrf-token': await csrfFor(cookieJar) },
    });
    expect(loggedOut.status).toBe(200);

    const after = await httpRequest(`${app.origin}/api/auth/me`, { cookie: cookieJar.header() });
    expect(after.status).toBe(401);
  }, 120_000);
});