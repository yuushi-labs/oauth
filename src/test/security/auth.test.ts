import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents, sessions } from '@/lib/db/schema';
import { getSession, revokeSession, createSession } from '@/lib/auth/session';
import { makeFixtureUser, cleanupFixtureUsers, STRONG_PASSWORD, type FixtureUser } from '@/test/helpers/fixtures';

vi.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
      set: (name: string, value: string) => void store.set(name, value),
      delete: (name: string) => void store.delete(name),
    }),
  };
});

vi.mock('@/lib/auth/rate-limit', async () => {
  const { createFakeRateLimiter } = await import('@/test/helpers/rate-limit');
  return { rateLimiter: createFakeRateLimiter() };
});
vi.mock('@/lib/auth/captcha', () => ({ verifyCaptchaIfRequired: vi.fn(async () => undefined) }));

import { POST as login } from '@/app/api/auth/login/route';

/**
 * §48「認証」カテゴリの正規テスト（D-38-05）。
 *
 * 既存の細分化テスト（`deleted-account-login` / `email-unverified-login` / `enumeration` 等）は
 * 残したうえで、§48 のトラッカーが参照する**正規ファイル名**として主要ケースをここへ集約する。
 * 実 PostgreSQL と Route Handler を使い、DB モックに依存しない。
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-auth';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');

function loginRequest(identifier: string, password: string): NextRequest {
  return new NextRequest(new Request(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ email_or_username: identifier, password }),
  }));
}

const userIds: string[] = [];
let user: FixtureUser;

beforeEach(async () => {
  user = await makeFixtureUser();
  userIds.push(user.id);
});

afterAll(async () => {
  await cleanupFixtureUsers(userIds);
});

describe('Security - authentication (§48)', () => {
  it('正しいパスワードでログインでき、セッションを発行する', async () => {
    const response = await login(loginRequest(user.email, STRONG_PASSWORD));
    expect(response.status).toBe(200);
    // セッション行が発行される（Cookie は next/headers をモックしているため DB で確認する）。
    const issued = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(issued).toHaveLength(1);
  });

  it('誤ったパスワードは 401 で拒否する', async () => {
    const response = await login(loginRequest(user.email, 'Wrong-Password-2026!'));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
    const issued = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(issued).toHaveLength(0);
  });

  it('存在しない email でも同じ 401（列挙防止・§48）', async () => {
    const response = await login(loginRequest('nobody-here@example.com', STRONG_PASSWORD));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('email 未確認は 403 EMAIL_NOT_VERIFIED で止まる', async () => {
    const unverified = await makeFixtureUser({ kind: 'unverified' });
    userIds.push(unverified.id);
    const response = await login(loginRequest(unverified.email, STRONG_PASSWORD));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('停止中アカウントは 403 で止まる', async () => {
    const suspended = await makeFixtureUser({ kind: 'suspended' });
    userIds.push(suspended.id);
    const response = await login(loginRequest(suspended.email, STRONG_PASSWORD));
    expect(response.status).toBe(403);
  });

  it('ログアウト（失効）後のセッションは無効になる', async () => {
    const { token, session } = await createSession(user.id, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' }),
    });
    expect(await getSession(token)).not.toBeNull();

    await revokeSession(session.id, 'logout');
    expect(await getSession(token)).toBeNull();
  });

  it('期限切れセッションは getSession が null を返す', async () => {
    const { token, session } = await createSession(user.id, {
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' }),
    });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, session.id));
    expect(await getSession(token)).toBeNull();
  });

  it('ログイン成功は login_success を記録する', async () => {
    await login(loginRequest(user.email, STRONG_PASSWORD));
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(events.some((event) => event.eventType === 'login_success')).toBe(true);
  });
});
