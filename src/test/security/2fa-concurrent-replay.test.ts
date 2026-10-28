import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { totpCodeFor } from '@/test/helpers/totp';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, sessions, totp, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import type { SessionData } from '@/lib/auth/session';

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

import { POST as challengeVerify } from '@/app/api/auth/2fa/challenge/verify/route';

/**
 * §10 T3 / T13 / D-33-04: 同一 TOTP コードの並行送信は 1 件だけ成功する。
 * `last_used_counter < c` の単文 UPDATE の更新行数で判定するため、2 本目は 0 行更新 → INVALID_CODE。
 */

const appUrl = 'http://localhost:3000';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email: `${uniq('m')}@example.com`,
    emailVerified: true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

function sessionFor(userId: string): SessionData {
  return {
    id: `ses_${uniq('s')}`,
    userId,
    sessionHash: `hash-${uniq('h')}`,
    csrfSecret: 'csrf-secret',
    userAgent: 'vitest',
    ip: '127.0.0.1',
    ipMasked: '127.0.0.0',
    ipHash: null,
    deviceName: 'vitest',
    reauthVerifiedAt: null,
    totpPending: true,
  };
}

async function persistSession(session: SessionData): Promise<void> {
  createdSessionIds.push(session.id);
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(session.sessionHash).digest('hex');
  await getDb().execute(sql`
    INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at,
                          ip_masked, device_name, reauth_verified_at, totp_pending)
    VALUES (${session.id}, ${session.userId}, ${sessionHash}, ${session.csrfSecret}, ${session.userAgent},
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '1 day', ${session.ipMasked}, ${session.deviceName},
            NULL, true)
  `);
}

function request(session: SessionData, code: string): NextRequest {
  return new NextRequest(`${appUrl}/api/auth/2fa/challenge/verify`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_session=${session.sessionHash}`,
      'x-csrf-token': deriveCsrfToken(session),
    },
    body: JSON.stringify({ code }),
  });
}

async function seedEnabledTotp(userId: string): Promise<void> {
  await getDb().insert(totp).values({
    userId,
    secretEncrypted: encryptTotpSecret(SECRET),
    enabled: true,
    confirmedAt: new Date(),
    lastUsedCounter: -1,
  });
}

function codeFor(offsetSeconds: number): string {
  return totpCodeFor(SECRET, new Date(Date.now() + offsetSeconds * 1000));
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
  const db = getDb();
  await db.execute(sql`DELETE FROM rate_limit_hits`);
  await db.execute(sql`DELETE FROM rate_limit_reservations`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const id of createdSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of createdUserIds.splice(0)) {
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - 2FA concurrent replay (T3 / T13 / D-16)', () => {
  it('★ 同一コードを 2 並行送信 → 成功 1 件・他方 400 INVALID_CODE', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const a = sessionFor(userId);
    const b = sessionFor(userId);
    await persistSession(a);
    await persistSession(b);

    const code = codeFor(0);
    const [ra, rb] = await Promise.all([
      challengeVerify(request(a, code)),
      challengeVerify(request(b, code)),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 400]);

    const failed = ra.status === 400 ? ra : rb;
    expect((await failed.json()).error.code).toBe('INVALID_CODE');
  });

  it('同じコードの 3 回目（逐次）も 400', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const code = codeFor(0);

    const first = sessionFor(userId);
    await persistSession(first);
    expect((await challengeVerify(request(first, code))).status).toBe(200);

    for (let i = 0; i < 2; i += 1) {
      const s = sessionFor(userId);
      await persistSession(s);
      const response = await challengeVerify(request(s, code));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_CODE');
    }
  });

  it('T13: 古い counter のコードを後から送ると 400（counter は巻き戻らない）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);

    // 現在のコードで昇格（counter = base を消費）
    const now = sessionFor(userId);
    await persistSession(now);
    expect((await challengeVerify(request(now, codeFor(0)))).status).toBe(200);

    // 30 秒前のコード（counter = base - 1）は単調増加に反するので 0 行更新
    const old = sessionFor(userId);
    await persistSession(old);
    const response = await challengeVerify(request(old, codeFor(-30)));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CODE');
  });
});
