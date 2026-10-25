import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, securityEvents, sessions, totp, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import { RATE_LIMITS } from '@/config/rate-limits';
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
 * §10 T2 / T5: 2FA 入力は `rateLimitKeys.twoFactorUser` で 10 回/5 分に制限される。
 * 11 回目は 429。ウィンドウ経過で回復する。
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

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
  const db = getDb();
  await db.execute(sql`DELETE FROM rate_limit_hits`);
  await db.execute(sql`DELETE FROM rate_limit_reservations`);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  const db = getDb();
  for (const id of createdSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of createdUserIds.splice(0)) {
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - 2FA brute force (T2 / T5)', () => {
  it('誤コードを 10 回送ると 11 回目は 429', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await challengeVerify(request(session, '000000'))).status);
    }

    // 1〜10 回目はコード不一致の 400、11 回目はレート制限の 429
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('11 回目の 429 で rate_limited（scope=2fa）が記録される', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    for (let i = 0; i < 11; i += 1) {
      await challengeVerify(request(session, '000000'));
    }

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    const limited = events.find((e) => e.eventType === 'rate_limited');
    expect(limited).toBeDefined();
    expect(limited!.metadata).toMatchObject({ scope: '2fa' });
  });

  it('ウィンドウ（5 分）経過で回復する', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    for (let i = 0; i < 11; i += 1) {
      await challengeVerify(request(session, '000000'));
    }
    expect((await challengeVerify(request(session, '000000'))).status).toBe(429);

    // レート制限は DB の実時刻で判定するため、行のウィンドウを過去へ移して回復を再現する
    await getDb().execute(sql`UPDATE rate_limit_hits SET window_expires_at = now() - INTERVAL '1 second'`);

    const recovered = await challengeVerify(request(session, '000000'));
    expect(recovered.status).toBe(400);
  });

  it('RATE_LIMITS.twoFactor は 10/5 分', () => {
    expect(RATE_LIMITS.twoFactor.limit).toBe(10);
    expect(RATE_LIMITS.twoFactor.window).toBe(300_000);
  });
});
