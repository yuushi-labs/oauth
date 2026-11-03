// @ts-nocheck
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db/client';
import { accounts, securityEvents, sessions, users, webauthnCredentials } from '@/lib/db/schema';
import { startTestAppServer, type TestAppServer } from '../helpers/app-server';
import { CookieJar, cleanupTestRows, httpRequest } from '../helpers/http';
import { createMockAuthenticator } from '../helpers/webauthn-mock';

/**
 * §48 / §6 の E2E 通し（登録 → 確認 → ログイン → 2FA → Passkey → 設定 → 削除）。
 *
 * 実 HTTP（`startTestAppServer`）に対して Cookie / ステータス / JSON を検証する（D-38-04。
 * Playwright は使わない）。メール本文は Next のバンドル境界を跨げないため、確認メールの
 * 「クリック」は DB の状態を直接確定させて代替する（メール送信そのものは §18 の各テストが担保）。
 */
const uid = randomBytes(4).toString('hex');
const email = `journey-${uid}@example.com`;
const username = `journey_${uid}`;
const password = 'Journey-Strong-Pass-2026!';

let app: TestAppServer;
let jars: CookieJar[] = [];

function jar(): CookieJar {
  const created = new CookieJar();
  jars.push(created);
  return created;
}

async function csrfFor(cookieJar: CookieJar): Promise<string> {
  const response = await httpRequest(`${app.origin}/api/auth/csrf`, { cookie: cookieJar.header() });
  cookieJar.store(response.headers);
  return response.json<{ data: { csrfToken: string } }>().data.csrfToken;
}

/** CSRF トークンは cookie を seed した後に取る必要があるため、POST をここに集約する。 */
async function postJson(path: string, cookieJar: CookieJar, body: unknown) {
  const token = await csrfFor(cookieJar);
  return httpRequest(`${app.origin}${path}`, {
    method: 'POST',
    cookie: cookieJar.header(),
    headers: { 'content-type': 'application/json', origin: app.origin, 'x-csrf-token': token },
    body: JSON.stringify(body),
  });
}

function totpCode(secretBase32: string): string {
  return new TOTP({ secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
    .generate({ timestamp: Date.now() });
}

beforeAll(async () => {
  app = await startTestAppServer({ dev: true, oidc: false });
}, 120_000);

afterEach(() => {
  jars = [];
});

afterAll(async () => {
  const pool = getPool();
  const ids = (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows.map((row) => row.id);
  for (const id of ids) {
    await getDb().delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    await getDb().delete(accounts).where(eq(accounts.userId, id));
    await getDb().delete(securityEvents).where(eq(securityEvents.userId, id));
    await getDb().delete(sessions).where(eq(sessions.userId, id));
  }
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [] });
  if (app) await app.stop();
}, 120_000);

describe('E2E - auth journey (§48)', () => {
  it('登録 → ログイン（誤 PW は 401）→ 2FA → Passkey → 設定 → 削除', async () => {
    // --- 1. 登録（列挙耐性のため応答は常に同一メッセージ。即時有効化・D-40-01）---
    const signupJar = jar();
    const register = await postJson('/api/auth/register', signupJar, { email, username, password });
    expect(register.status, `register body: ${register.body}`).toBe(200);
    const [pending] = await getDb().select().from(users).where(eq(users.email, email));
    expect(pending).toBeDefined();
    expect(pending.status).toBe('active');
    expect(pending.emailVerified).toBe(true);

    // --- 3. ログイン（誤 PW は 401、正 PW は 200）---
    const loginJar = jar();
    const wrong = await postJson('/api/auth/login', loginJar, { email_or_username: email, password: 'Wrong-Pass-2026!' });
    expect(wrong.status, `wrong login body: ${wrong.body}`).toBe(401);

    const login = await postJson('/api/auth/login', loginJar, { email_or_username: email, password });
    expect(login.status, `login body: ${login.body}`).toBe(200);
    loginJar.store(login.headers);
    expect(loginJar.get(process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session')).toBeTruthy();

    // --- 4. 2FA 有効化 → 新規ログインは保留 → challenge で昇格 ---
    const setup = await postJson('/api/auth/2fa/setup', loginJar, {});
    expect(setup.status, `setup body: ${setup.body}`).toBe(200);
    const secret = setup.json<{ data: { secret: string } }>().data.secret;

    const enable = await postJson('/api/auth/2fa/verify', loginJar, { code: totpCode(secret) });
    expect(enable.status, `enable body: ${enable.body}`).toBe(200);
    const recoveryCodes = enable.json<{ data: { recovery_codes: string[] } }>().data.recovery_codes;
    expect(recoveryCodes).toHaveLength(10);
    // TOTP カウンタは 1 回限り消費（D-16）。同一 30 秒窓での再検証はリカバリーコードで行う。
    const recovery = recoveryCodes.values();

    const pendingJar = jar();
    const pendingLogin = await postJson('/api/auth/login', pendingJar, { email_or_username: email, password });
    expect(pendingLogin.status).toBe(200);
    expect(pendingLogin.json<{ data: { twoFactorRequired: boolean } }>().data.twoFactorRequired).toBe(true);
    pendingJar.store(pendingLogin.headers);

    // 保留セッションでは保護 API が拒否される（昇格前の封じ込め・D-33-08）。
    // `/api/auth/me` は保留判定のために例外的に許可されるので、通常の保護 API で確認する。
    const pendingGuard = await httpRequest(`${app.origin}/api/auth/sessions`, { cookie: pendingJar.header() });
    expect(pendingGuard.status, `pending guard body: ${pendingGuard.body}`).toBe(403);

    const badChallenge = await postJson('/api/auth/2fa/challenge/verify', pendingJar, { code: '000000' });
    expect(badChallenge.status).toBe(400);

    const challenge = await postJson('/api/auth/2fa/challenge/verify', pendingJar, { code: recovery.next().value });
    expect(challenge.status, `challenge body: ${challenge.body}`).toBe(200);
    expect(challenge.json<{ data: { verified: boolean } }>().data.verified).toBe(true);
    expect((await httpRequest(`${app.origin}/api/auth/me`, { cookie: pendingJar.header() })).status).toBe(200);

    // --- 5. Passkey 登録 → Passkey ログイン ---
    // 昇格済みの保留セッションをそのまま使い、Passkey を登録する（再認証必須）。
    const reauth = await postJson('/api/auth/reauth', pendingJar, { password });
    expect(reauth.status, `reauth body: ${reauth.body}`).toBe(200);

    const options = await postJson('/api/auth/passkey/register/options', pendingJar, {});
    expect(options.status, `options body: ${options.body}`).toBe(200);
    const regOptions = options.json<{ data: { options: { challenge: string }; challenge_id: string } }>().data;

    const authenticator = createMockAuthenticator({ rpID: '127.0.0.1', origin: app.origin });
    const registrationResponse = authenticator.createRegistrationResponse({ challenge: regOptions.options.challenge });
    const registered = await postJson('/api/auth/passkey/register/verify', pendingJar, {
      response: registrationResponse,
      challenge_id: regOptions.challenge_id,
    });
    expect(registered.status, `register body: ${registered.body}`).toBe(200);

    const pkJar = jar();
    const authOptions = await postJson('/api/auth/passkey/login/options', pkJar, {});
    expect(authOptions.status).toBe(200);
    const loginOptions = authOptions.json<{ data: { options: { challenge: string }; challenge_id: string } }>().data;
    const assertion = authenticator.createAuthenticationResponse({ challenge: loginOptions.options.challenge });
    const passkeyLogin = await postJson('/api/auth/passkey/login/verify', pkJar, {
      response: assertion,
      challenge_id: loginOptions.challenge_id,
    });
    expect(passkeyLogin.status, `passkey login body: ${passkeyLogin.body}`).toBe(200);
    pkJar.store(passkeyLogin.headers);

    // --- 6. 設定（セッション一覧）---
    const sessionList = await httpRequest(`${app.origin}/api/auth/sessions`, { cookie: pkJar.header() });
    expect(sessionList.status).toBe(200);
    expect(sessionList.json<{ data: { sessions: unknown[] } }>().data.sessions.length).toBeGreaterThanOrEqual(2);

    // --- 7. 削除（強い再認証: パスワード＋コード）---
    const deleteJar = jar();
    const deleteSession = await postJson('/api/auth/login', deleteJar, { email_or_username: email, password });
    deleteJar.store(deleteSession.headers);
    await postJson('/api/auth/2fa/challenge/verify', deleteJar, { code: recovery.next().value });
    const deleteReauth = await postJson('/api/auth/reauth', deleteJar, { password });
    expect(deleteReauth.status, `delete reauth body: ${deleteReauth.body}`).toBe(200);

    const deleted = await httpRequest(`${app.origin}/api/auth/account`, {
      method: 'DELETE',
      cookie: deleteJar.header(),
      headers: {
        'content-type': 'application/json',
        origin: app.origin,
        'x-csrf-token': await csrfFor(deleteJar),
      },
      body: JSON.stringify({ code: recovery.next().value }),
    });
    expect(deleted.status, `delete body: ${deleted.body}`).toBe(200);

    // 削除後は同じ資格情報でログインできない（停止扱い・§24）。
    const afterDeleteJar = jar();
    const relogin = await postJson('/api/auth/login', afterDeleteJar, { email_or_username: email, password });
    expect(relogin.status, `relogin body: ${relogin.body}`).toBe(403);

    // 削除時は全セッションが失効する（行は保持し revoked_at が入る）。
    const remaining = await getDb().select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.userId, pending.id), isNull(sessions.revokedAt)));
    expect(remaining[0]!.count).toBe(0);
  }, 120_000);
});
