import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  DEFAULT_ROLE_ID,
  emailVerificationTokens,
  passwordResetTokens,
  securityEvents,
  sessions,
  users,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { useMemoryEmail, restoreResendEmail } from '@/test/helpers/email';

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

// HIBP is a network call; the route's own behaviour under test is the duplicate handling.
vi.mock('@/lib/auth/breached', () => ({
  checkBreached: vi.fn(async () => ({ breached: false, failOpen: false })),
}));

import { POST as register } from '@/app/api/auth/register/route';
import { POST as forgot } from '@/app/api/auth/password/forgot/route';

/**
 * §46 / D-04: 一意制約違反（重複 email / username）は成功時と**同一の 200 メッセージ**に
 * ならなければならない。Drizzle 0.45 は postgres のエラーを `DrizzleQueryError` で包み、
 * SQLSTATE は `err.cause.code` に入るため、`err.code` だけを見ると捕捉できない。
 * ここでは実 Route Handler と実 DB を通し、重複登録が 500 にならないことを固定する。
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-register-duplicate';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43))
  .update(anonSecret)
  .digest('hex');

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

function registerRequest(body: unknown): NextRequest {
  return new NextRequest(`${appUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'vitest',
    },
    body: JSON.stringify(body),
  });
}

function forgotRequest(body: unknown): NextRequest {
  return new NextRequest(`${appUrl}/api/auth/password/forgot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'vitest',
    },
    body: JSON.stringify(body),
  });
}

async function makeUser(options: { email: string; username: string }): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: options.username,
    email: options.email,
    emailVerified: true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
  useMemoryEmail();
  // レート制限は実 DB を共有する。fileParallelism: false なので全行消して汚染を防ぐ。
  const db = getDb();
  await db.execute('DELETE FROM rate_limit_hits');
  await db.execute('DELETE FROM rate_limit_reservations');
});

afterEach(() => {
  restoreResendEmail();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, id));
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - register duplicate handling (D-04 / §46)', () => {
  it('新規登録は 200 で確認メール送信メッセージを返す', async () => {
    const response = await register(
      registerRequest({
        email: `${uniq('m')}@example.com`,
        username: uniq('u'),
        password: 'Strong-Password-2026!',
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ message: '確認メールを送信しました' });
  });

  it('重複 email は 500 ではなく、成功時と同一の 200 を返す', async () => {
    const email = `${uniq('m')}@example.com`;
    await makeUser({ email, username: uniq('u') });

    const response = await register(
      registerRequest({ email, username: uniq('u'), password: 'Strong-Password-2026!' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ message: '確認メールを送信しました' });
  });

  it('重複 username は 500 ではなく、成功時と同一の 200 を返す', async () => {
    const username = uniq('u');
    await makeUser({ email: `${uniq('m')}@example.com`, username });

    const response = await register(
      registerRequest({
        email: `${uniq('m')}@example.com`,
        username,
        password: 'Strong-Password-2026!',
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ message: '確認メールを送信しました' });
  });
});

describe('Security - password forgot message (§46)', () => {
  it('存在する email でも 200 で「リセットメールを送信しました（存在する場合）」を返す', async () => {
    const email = `${uniq('m')}@example.com`;
    await makeUser({ email, username: uniq('u') });

    const response = await forgot(forgotRequest({ email }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      message: 'リセットメールを送信しました（存在する場合）',
    });
  });
});
