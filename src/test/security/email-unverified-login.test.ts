import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, securityEvents, sessions, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';

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

import { POST as login } from '@/app/api/auth/login/route';

/**
 * §8.7 / D-33-21 / T18 / T24: 未確認 email ではログインさせない。セッションを発行せず、
 * 再送導線（`data.email` + `resend_available`）を返す。列挙対策として `data.email` は
 * パスワード認証成功後にのみ返る。
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-email-unverified';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(options: { emailVerified: boolean; status: 'active' | 'pending_email' }): Promise<{ id: string; email: string }> {
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: options.emailVerified,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: options.status,
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return { id, email };
}

function loginRequest(identifier: string, password: string): NextRequest {
  return new NextRequest(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'vitest',
    },
    body: JSON.stringify({ email_or_username: identifier, password }),
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - email unverified login (D-33-21 / T18)', () => {
  it('未確認 email は 403 EMAIL_NOT_VERIFIED で止まる', async () => {
    const { email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    const response = await login(loginRequest(email, 'Strong-Password-2026!'));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('セッションが 1 件も発行されない（DB で確認）', async () => {
    const { id, email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    await login(loginRequest(email, 'Strong-Password-2026!'));
    const issued = await getDb().select().from(sessions).where(eq(sessions.userId, id));
    expect(issued).toHaveLength(0);
  });

  it('応答の data に email と resend_available: true を含む', async () => {
    const { email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    const response = await login(loginRequest(email, 'Strong-Password-2026!'));
    const body = await response.json();
    expect(body.data).toEqual({ email, resend_available: true });
  });

  it('login_failed を metadata.reason=email_unverified 付きで記録する', async () => {
    const { id, email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    await login(loginRequest(email, 'Strong-Password-2026!'));
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, id));
    const failed = events.find((e) => e.eventType === 'login_failed');
    expect(failed).toBeDefined();
    expect(failed!.metadata).toMatchObject({ reason: 'email_unverified' });
  });

  it('確認済みユーザーは従来どおり 200（回帰防止）', async () => {
    const { email } = await makeUser({ emailVerified: true, status: 'active' });
    const response = await login(loginRequest(email, 'Strong-Password-2026!'));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ message: 'ログインしました' });
  });

  it('T24: パスワードが違えば data.email は返らない（列挙対策）', async () => {
    const { email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    const response = await login(loginRequest(email, 'Wrong-Password-2026!'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(body.data).toBeUndefined();
  });
});
