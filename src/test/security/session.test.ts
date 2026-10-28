import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { createSession, getSession, revokeAllSessions, revokeSession } from '@/lib/auth/session';
import { ANON_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/lib/auth/cookie';
import { makeFixtureUser, cleanupFixtureUsers, type FixtureUser } from '@/test/helpers/fixtures';

/**
 * §48「セッション」カテゴリの正規テスト（D-38-05）。
 *
 * 既存の `session-attr` / `session-management` は残し、正規ファイル名として
 * Cookie 属性・セッション固定（発行ごとに ID が変わる）・全失効後の旧 Cookie 拒否・
 * DB には hash だけを保存することをここで固定する。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36';

const userIds: string[] = [];
let user: FixtureUser;

beforeEach(async () => {
  user = await makeFixtureUser();
  userIds.push(user.id);
});

afterAll(async () => {
  await cleanupFixtureUsers(userIds);
});

describe('Security - session (§48)', () => {
  it('Cookie 名は __Host- プレフィックスで、anon も同様（§6.2）', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-auth_session');
    expect(ANON_COOKIE_NAME).toBe('__Host-auth_anon');
  });

  it('DB には生 token ではなく HMAC した session_hash だけを保存する（§45）', async () => {
    const { token, session } = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, session.id));
    expect(row!.sessionHash).not.toBe(token);
    const expected = createHmac('sha256', process.env.SESSION_PEPPER!).update(token).digest('hex');
    expect(row!.sessionHash).toBe(expected);
    // 生 token は DB のどこにも現れない。
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('セッション固定対策: 発行ごとに token / id / hash が変化する', async () => {
    const first = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    const second = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    expect(first.token).not.toBe(second.token);
    expect(first.session.id).not.toBe(second.session.id);
    expect(first.session.sessionHash).not.toBe(second.session.sessionHash);
  });

  it('全セッション失効（logout-all）後は旧 Cookie の token が拒否される', async () => {
    const first = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    const second = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    expect(await getSession(first.token)).not.toBeNull();

    await revokeAllSessions(user.id, 'logout_all');

    expect(await getSession(first.token)).toBeNull();
    expect(await getSession(second.token)).toBeNull();
  });

  it('個別失効したセッションだけが無効になる', async () => {
    const first = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    const second = await createSession(user.id, { headers: new Headers({ 'user-agent': UA }) });
    await revokeSession(first.session.id, 'manual');

    expect(await getSession(first.token)).toBeNull();
    expect(await getSession(second.token)).not.toBeNull();
  });

  it('未知の token は getSession が null を返す', async () => {
    expect(await getSession('sess_does_not_exist')).toBeNull();
  });
});
