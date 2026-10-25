import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  DEFAULT_ROLE_ID,
  emailVerificationTokens,
  securityEvents,
  sessions,
  users,
} from '@/lib/db/schema';
import { createUser, softDeleteUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { useMemoryEmail, restoreResendEmail } from '@/test/helpers/email';

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

import { POST as resend } from '@/app/api/auth/resend-verification/route';

/**
 * §8.9 / D-33-22 / T19 / T20 / T21: 未認証でも確認メールを再送できる。
 * 応答は常に同一（列挙対策）。実際に送るのは `pending_email` かつ未確認のときだけ。
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-resend';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(options: {
  emailVerified: boolean;
  status: 'active' | 'pending_email';
}): Promise<{ id: string; email: string }> {
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

function anonRequest(body: unknown): NextRequest {
  return new NextRequest(`${appUrl}/api/auth/resend-verification`, {
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

function tokenCount(userId: string): Promise<number> {
  return getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .then((rows) => rows[0]?.count ?? 0);
}

let mail: ReturnType<typeof useMemoryEmail>;

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
  mail = useMemoryEmail();
  // レート制限キーは保存前に hash されるため、全行を消してテスト間の汚染を防ぐ
  // （`fileParallelism: false` なので他ファイルと競合しない）。
  const db = getDb();
  await db.execute(sql`DELETE FROM rate_limit_hits`);
  await db.execute(sql`DELETE FROM rate_limit_reservations`);
});

afterEach(async () => {
  restoreResendEmail();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - resend verification unauthenticated (D-33-22 / T19)', () => {
  it('セッション無しで 200 を返す', async () => {
    const { email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    const response = await resend(anonRequest({ email }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ message: '確認メールを送信しました' });
  });

  it('未確認ユーザーにだけトークンを発行し、メールを送る', async () => {
    const { id, email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    await resend(anonRequest({ email }));
    expect(await tokenCount(id)).toBe(1);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.to).toBe(email);
  });

  it('T20: 存在しない / 確認済み / 停止中 / 削除済み で応答が完全一致', async () => {
    const verified = await makeUser({ emailVerified: true, status: 'active' });
    const suspended = await makeUser({ emailVerified: false, status: 'pending_email' });
    await getDb().update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.id));
    const deleted = await makeUser({ emailVerified: false, status: 'pending_email' });
    await softDeleteUser(deleted.id);

    const bodies: string[] = [];
    const statuses: number[] = [];
    for (const email of ['nobody@example.com', verified.email, suspended.email, deleted.email]) {
      const response = await resend(anonRequest({ email }));
      statuses.push(response.status);
      bodies.push(await response.text());
    }

    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(new Set(bodies).size).toBe(1);

    // 確認済み / 停止中 / 削除済み にはトークンを発行しない
    expect(await tokenCount(verified.id)).toBe(0);
    expect(await tokenCount(suspended.id)).toBe(0);
    expect(await tokenCount(deleted.id)).toBe(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('T21: 同じ email へ 6 回目の再送は 429', async () => {
    const { email } = await makeUser({ emailVerified: false, status: 'pending_email' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await resend(anonRequest({ email }))).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
