import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, securityEvents, sessions, users } from '@/lib/db/schema';
import { createUser, softDeleteUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';

// Route Handlers write cookies through `next/headers`; outside a request scope that throws.
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

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })),
    reserveFailedAttempt: vi.fn(async () => ({
      allowed: true,
      reservation: {
        reservationId: 'res_1',
        key: 'k',
        generation: 1,
        captchaRequired: false,
        resetAt: Date.now() + 60_000,
      },
    })),
    releaseReservation: vi.fn(async () => undefined),
    finishFailedAttempt: vi.fn(async () => false),
  },
}));
vi.mock('@/lib/auth/captcha', () => ({ verifyCaptchaIfRequired: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/notifications', () => ({
  isFirstSessionFromDevice: vi.fn(async () => false),
  notifyNewDeviceLogin: vi.fn(async () => true),
}));

import { POST as login } from '@/app/api/auth/login/route';

/**
 * §23/§24: a soft-deleted account must not authenticate again. Deletion revokes every
 * session and OAuth grant, so letting the same credentials mint a new session silently
 * undoes the deletion. The OAuth callback rejects every non-active status
 * (`complete-login.ts`), but the password login route only rejected `suspended`.
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-deleted-login';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43))
  .update(anonSecret)
  .digest('hex');

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(
  password: string,
  status: 'active' | 'suspended' | 'pending_email' = 'active',
): Promise<{ id: string; email: string }> {
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: status === 'active',
    passwordHash: await hashPassword(password),
    status,
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return { id, email };
}

function loginRequest(identifier: string, password: string): NextRequest {
  return new NextRequest(new Request(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'vitest',
    },
    body: JSON.stringify({ email_or_username: identifier, password }),
  }));
}

beforeEach(() => undefined);
afterEach(() => undefined);

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - deleted accounts cannot log in (spec 23/24)', () => {
  it('論理削除済みユーザーは正しいパスワードでもログインできない', async () => {
    const password = 'Strong-Password-2026!';
    const { id, email } = await makeUser(password);

    await softDeleteUser(id);

    const response = await login(loginRequest(email, password));
    expect(response.status).toBe(403);

    // セッションを発行していないこと（削除の取り消しになっていないこと）
    const issued = await getDb().select().from(sessions).where(eq(sessions.userId, id));
    expect(issued).toHaveLength(0);
  });

  it('停止中ユーザーは従来どおりログインできない（回帰防止）', async () => {
    const password = 'Strong-Password-2026!';
    const { email } = await makeUser(password, 'suspended');

    const response = await login(loginRequest(email, password));
    expect(response.status).toBe(403);
  });

  it('email 未確認でもログインできる（D-40-02）', async () => {
    const password = 'Strong-Password-2026!';
    const { id, email } = await makeUser(password, 'pending_email');

    const response = await login(loginRequest(email, password));
    expect(response.status).toBe(200);

    // セッションが発行される
    const issued = await getDb().select().from(sessions).where(eq(sessions.userId, id));
    expect(issued).toHaveLength(1);
  });
});
