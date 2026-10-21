// @ts-nocheck
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startTestAppServer } from '../helpers/app-server';
import { CookieJar, cleanupTestRows, httpRequest } from '../helpers/http';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

/**
 * 設定メニューのハンバーガー化（外観変更）。
 *
 * 幅による出し分けは CSS（lg:）で行うため、SSR HTML には
 * 常時表示のナビとハンバーガーボタンの両方が含まれる。ここでは
 * - ハンバーガーボタンが aria-expanded / aria-controls を持つこと
 * - 8 つのリンクが（幅に依らず）すべて描画されること（機能は変えない）
 * - 現在地が aria-current="page" で示されること
 * を実 HTTP の SSR HTML で固定する。
 */
const uid = randomBytes(4).toString('hex');
const email = `settings-nav-${uid}@example.com`;
const username = `settings_nav_${uid}`;
const userId = `usr_settings_nav_${uid}`;

const NAV_LINKS = [
  '/settings/account',
  '/settings/security',
  '/settings/sessions',
  '/settings/password',
  '/settings/appearance',
  '/settings/connected-accounts',
  '/settings/connected-apps',
  '/settings/applications',
];

let app: Awaited<ReturnType<typeof startTestAppServer>>;
let jars: CookieJar[] = [];

function jar(): CookieJar {
  const created = new CookieJar();
  jars.push(created);
  return created;
}

async function authedJar(): Promise<CookieJar> {
  const cookieJar = jar();
  const session = await createSession(userId, {
    headers: new Headers({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36',
    }),
  });
  cookieJar.seed(
    process.env.NODE_ENV === 'production' ? '__Host-auth_session' : 'auth_session',
    session.token,
  );
  return cookieJar;
}

beforeAll(async () => {
  app = await startTestAppServer({ dev: true, oidc: true });
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
    [
      userId,
      username,
      email,
      await hashPassword('Settings-Nav-Strong-Pass-2026!'),
      DEFAULT_ROLE_ID,
    ],
  );
}, 120_000);

afterEach(() => {
  jars = [];
});

afterAll(async () => {
  await cleanupTestRows({ emails: [email], usernames: [username], clientIds: [] });
  if (app) await app.stop();
}, 60_000);

describe('E2E - settings hamburger navigation', () => {
  it('ハンバーガーボタンが aria-expanded / aria-controls を持つ', async () => {
    const cookieJar = await authedJar();
    const response = await httpRequest(`${app.origin}/settings/account`, {
      cookie: cookieJar.header(),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('aria-expanded="false"');
    expect(response.body).toContain('aria-controls="settings-nav"');
  }, 60_000);

  it('幅に依らず 8 つの設定リンクがすべて描画される（機能は変えない）', async () => {
    const cookieJar = await authedJar();
    const response = await httpRequest(`${app.origin}/settings/account`, {
      cookie: cookieJar.header(),
    });
    for (const href of NAV_LINKS) {
      expect(response.body, `${href} が描画される`).toContain(`href="${href}"`);
    }
  }, 60_000);

  it('現在地のリンクが aria-current="page" で示される', async () => {
    const cookieJar = await authedJar();
    const response = await httpRequest(`${app.origin}/settings/security`, {
      cookie: cookieJar.header(),
    });
    expect(response.body).toContain('aria-current="page"');
  }, 60_000);
});
