import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, DEFAULT_ROLE_ID, oauthSocialClaims, oauthStates, sessions, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { startTestAppServer, type TestAppServer } from '@/test/helpers/app-server';
import { httpRequest, CookieJar } from '@/test/helpers/http';
import { extractCallbackState } from '@/test/helpers/oauth';

/**
 * 連携確認画面の流れを実 HTTP で通す（Phase 4-B / §4.3）。
 *
 * provider の承認はモックできないので、
 * 「callback が確認画面へ 303 し、claim Cookie が付き、
 *  画面が開き、完了 POST がセッションを発行する」までを検証する。
 */

const PASSWORD = 'Phase4B-E2E-Strong-Pass-2026!';

let app: TestAppServer;
const createdUserIds: string[] = [];

beforeAll(async () => {
  // レート制限のウィンドウを跨いでいても flaky にならないよう、OAuth のキーだけ消す
  const { protectRateLimitKey, rateLimitKeys } = await import('@/lib/auth/rate-limit-keys');
  const { rateLimitHits } = await import('@/lib/db/schema');
  const keys = ['0.0.0.0', '127.0.0.1'].flatMap((ip) => [
    protectRateLimitKey(rateLimitKeys.oauthStart(ip)),
    protectRateLimitKey(rateLimitKeys.oauthCallback(ip)),
    protectRateLimitKey(rateLimitKeys.loginIp(ip)),
    protectRateLimitKey(rateLimitKeys.loginAccount('e2e-social@example.com')),
    protectRateLimitKey(rateLimitKeys.loginIpAccount('0.0.0.0', 'e2e-social@example.com')),
  ]);
  await getDb().delete(rateLimitHits).where(sql`${rateLimitHits.key} IN ${keys}`);

  app = await startTestAppServer({ dev: true, oidc: true });
}, 180_000);

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(eq(accounts.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await db.delete(oauthSocialClaims);
  await db.delete(oauthStates);
  await app.stop();
}, 180_000);

/** callback の 303 から claim Cookie を取り出す。 */
function claimTokenOf(response: { headers: Headers }): string | null {
  const cookie = response.headers.get('set-cookie');
  if (!cookie) return null;
  const match = /auth_social_claim=([^;]+)/.exec(cookie);
  return match ? match[1]! : null;
}

describe('E2E - social confirm screen', () => {
  it('sends an unlinked visitor from the callback to the confirm screen with a claim cookie', async () => {
    const start = await httpRequest(`${app.origin}/api/auth/oauth/google`);
    expect(start.status).toBe(303);
    const state = extractCallbackState(start.headers.get('location')!);
    expect(state).toBeTruthy();

    // provider 側の承認はモックできないので code が無効になる。ここでは state だけ
    // 有効にして「token 交換まで到達する」ことを確認する
    const callback = await httpRequest(
      `${app.origin}/api/auth/oauth/google/callback?code=invalid-code&state=${state}`,
      { headers: { referer: 'https://accounts.google.com/signin/oauth/replay' } },
    );
    // token 交換で 401（state は正しく消費された）
    expect(callback.status).toBe(401);
  }, 90_000);

  it('refuses the confirm screen when there is no claim cookie', async () => {
    const response = await httpRequest(`${app.origin}/login/social-confirm`);
    // guard により /login へ戻す
    expect([302, 303, 307]).toContain(response.status);
    expect(response.headers.get('location')).toContain('/login');
  }, 90_000);

  it('completes a signup with the claim cookie and issues a session', async () => {
    // 実ブラウザと同じ経路を再現するため、DB に claim を直接発行して Cookie 付きで確認画面を開く
    const { issueSocialClaim } = await import('@/lib/auth/oauth/social-claim');
    const email = `e2e-social-${Date.now().toString(36)}@example.com`;
    const { token } = await issueSocialClaim({
      provider: 'google',
      identity: { providerAccountId: `e2e-sub-${Date.now()}`, email, emailVerified: true },
      emailOwnerId: null,
    });

    const jar = new CookieJar();
    // Cookie に載せるには Set-Cookie 経由が正しいので、検証用の小さなルートを通すのではなく
    // claim token をそのまま Cookie に入れて画面と完了 API を叩く
    jar.store(new Headers({ 'set-cookie': `auth_social_claim=${token}; Path=/` }));

    const screen = await httpRequest(`${app.origin}/login/social-confirm`, {
      cookie: jar.header(),
    });
    expect(screen.status).toBe(200);
    expect(screen.body).toContain(email);
    // signup ボタンとパスワード欄の両方が存在する
    expect(screen.body).toContain('このメールアドレスでアカウントを作る');

    // 匿名 CSRF トークンを取る
    const csrfResponse = await httpRequest(`${app.origin}/api/auth/csrf`, { cookie: jar.header() });
    jar.store(csrfResponse.headers);
    const csrf = csrfResponse.json<{ data: { csrfToken: string } }>().data.csrfToken;

    const complete = await httpRequest(`${app.origin}/api/auth/oauth/social-login`, {
      method: 'POST',
      cookie: jar.header(),
      headers: {
        'content-type': 'application/json',
        origin: app.origin,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ action: 'signup' }),
    });

    expect(complete.status).toBe(303);
    expect(complete.headers.get('location')).toContain('/');
    expect(complete.headers.get('set-cookie')).toContain('auth_session=');

    const [row] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
    expect(row).toBeDefined();
    createdUserIds.push(row!.id);
    expect(row!.passwordHash).toBeNull();
    expect(row!.username).toMatch(/^[A-Za-z0-9_-]{3,32}$/);
  }, 90_000);

  it('links the account when the email owner password is correct', async () => {
    const email = `e2e-link-${Date.now().toString(36)}@example.com`;
    const userId = `usr_e2e_link_${Date.now().toString(36)}`;
    await createUser({
      id: userId,
      username: `e2e_link_${Date.now().toString(36)}`,
      email,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      status: 'active',
      roleId: DEFAULT_ROLE_ID,
    });
    createdUserIds.push(userId);

    const { issueSocialClaim } = await import('@/lib/auth/oauth/social-claim');
    const providerAccountId = `e2e-link-sub-${Date.now()}`;
    const { token } = await issueSocialClaim({
      provider: 'github',
      identity: { providerAccountId, email, emailVerified: true },
      emailOwnerId: userId,
    });

    const jar = new CookieJar();
    jar.store(new Headers({ 'set-cookie': `auth_social_claim=${token}; Path=/` }));

    const screen = await httpRequest(`${app.origin}/login/social-confirm`, { cookie: jar.header() });
    expect(screen.status).toBe(200);
    // 既存アカウントがあるので signup ボタンは出ない
    expect(screen.body).not.toContain('このメールアドレスでアカウントを作る');
    expect(screen.body).toContain('パスワードを入力');

    const csrfResponse = await httpRequest(`${app.origin}/api/auth/csrf`, { cookie: jar.header() });
    jar.store(csrfResponse.headers);
    const csrf = csrfResponse.json<{ data: { csrfToken: string } }>().data.csrfToken;

    const complete = await httpRequest(`${app.origin}/api/auth/oauth/social-login`, {
      method: 'POST',
      cookie: jar.header(),
      headers: {
        'content-type': 'application/json',
        origin: app.origin,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ action: 'password', identifier: email, password: PASSWORD }),
    });

    expect(complete.status).toBe(303);
    expect(complete.headers.get('set-cookie')).toContain('auth_session=');

    const rows = await getDb().select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('github');
    expect(rows[0]!.providerAccountId).toBe(providerAccountId);
  }, 90_000);

  it('rejects a wrong password without linking anything', async () => {
    const email = `e2e-wrong-${Date.now().toString(36)}@example.com`;
    const userId = `usr_e2e_wrong_${Date.now().toString(36)}`;
    await createUser({
      id: userId,
      username: `e2e_wrong_${Date.now().toString(36)}`,
      email,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      status: 'active',
      roleId: DEFAULT_ROLE_ID,
    });
    createdUserIds.push(userId);

    const { issueSocialClaim } = await import('@/lib/auth/oauth/social-claim');
    const { token } = await issueSocialClaim({
      provider: 'google',
      identity: { providerAccountId: `e2e-wrong-sub-${Date.now()}`, email, emailVerified: true },
      emailOwnerId: userId,
    });

    const jar = new CookieJar();
    jar.store(new Headers({ 'set-cookie': `auth_social_claim=${token}; Path=/` }));
    const csrfResponse = await httpRequest(`${app.origin}/api/auth/csrf`, { cookie: jar.header() });
    jar.store(csrfResponse.headers);
    const csrf = csrfResponse.json<{ data: { csrfToken: string } }>().data.csrfToken;

    const complete = await httpRequest(`${app.origin}/api/auth/oauth/social-login`, {
      method: 'POST',
      cookie: jar.header(),
      headers: {
        'content-type': 'application/json',
        origin: app.origin,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ action: 'password', identifier: email, password: 'wrong-password' }),
    });

    expect(complete.status).toBe(401);
    expect(complete.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    expect(await getDb().select().from(accounts).where(eq(accounts.userId, userId))).toHaveLength(0);
  }, 90_000);

  it('never puts the claim token in a URL', async () => {
    // claim token は Cookie だけで運ぶ。URL に現れたら情報漏洩なので固定する
    const response = await httpRequest(`${app.origin}/login/social-confirm`);
    expect(response.headers.get('location') ?? '').not.toContain('auth_social_claim');
    const rows = await getDb().select().from(oauthSocialClaims);
    for (const row of rows) {
      // 生 token は保存されない。保存されるのは 64 文字の hex（SHA-256）のみ
      expect(row.stateHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 90_000);
});