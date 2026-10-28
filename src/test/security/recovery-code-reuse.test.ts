import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { totpCodeFor } from '@/test/helpers/totp';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, recoveryCodes, securityEvents, sessions, totp, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from '@/lib/auth/recovery-codes';
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
 * §8.4 / D-33-12: 保留セッションの昇格。リカバリーコードは 1 回限り、TOTP は counter 消費。
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
            NULL, ${session.totpPending})
  `);
}

function request(session: SessionData, body: unknown): NextRequest {
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
    body: JSON.stringify(body),
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

async function seedRecoveryCodes(userId: string, count = 5): Promise<string[]> {
  const codes = generateRecoveryCodes().slice(0, count);
  await getDb().insert(recoveryCodes).values(
    codes.map((code) => ({
      id: `tok_${uniq('r')}`,
      userId,
      codeHash: hashRecoveryCode(normalizeRecoveryCode(code)),
    })),
  );
  return codes;
}

function codeFor(at: Date = new Date()): string {
  return totpCodeFor(SECRET, at);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const id of createdSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of createdUserIds.splice(0)) {
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - recovery code reuse (spec 48 / D-33-12)', () => {
  it('TOTP コードで昇格し、totp_pending が false になる', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    const response = await challengeVerify(request(session, { code: codeFor() }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.verified).toBe(true);
    expect(body.data.method).toBe('totp');

    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, session.id));
    expect(row!.totpPending).toBe(false);
  });

  it('リカバリーコードで昇格できる（残数が返る）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const codes = await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId);
    await persistSession(session);

    const response = await challengeVerify(request(session, { code: codes[0] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.method).toBe('recovery_code');
    expect(body.data.recovery_codes_remaining).toBe(4);
    expect(body.data.low).toBe(false);
  });

  it('同じリカバリーコードの 2 回目は 400 INVALID_CODE', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const codes = await seedRecoveryCodes(userId, 5);

    const first = sessionFor(userId);
    await persistSession(first);
    expect((await challengeVerify(request(first, { code: codes[0] }))).status).toBe(200);

    const second = sessionFor(userId);
    await persistSession(second);
    const reuse = await challengeVerify(request(second, { code: codes[0] }));
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error.code).toBe('INVALID_CODE');
  });

  it('残数が 3 未満になると警告フラグが返る', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const codes = await seedRecoveryCodes(userId, 3);

    const session = sessionFor(userId);
    await persistSession(session);
    const response = await challengeVerify(request(session, { code: codes[0] }));
    const body = await response.json();
    expect(body.data.recovery_codes_remaining).toBe(2);
    expect(body.data.low).toBe(true);
  });

  it('コード不一致（TOTP/リカバリーの区別なし）は一律 400 INVALID_CODE', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId);
    await persistSession(session);

    const wrongTotp = await challengeVerify(request(session, { code: '000000' }));
    expect(wrongTotp.status).toBe(400);
    expect((await wrongTotp.json()).error.code).toBe('INVALID_CODE');

    const wrongRecovery = await challengeVerify(request(session, { code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' }));
    expect(wrongRecovery.status).toBe(400);
    expect((await wrongRecovery.json()).error.code).toBe('INVALID_CODE');
  });

  it('失敗時は login_failed（scope=2fa）を記録する', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    await challengeVerify(request(session, { code: '000000' }));
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    const failed = events.find((e) => e.eventType === 'login_failed');
    expect(failed).toBeDefined();
    expect(failed!.metadata).toMatchObject({ scope: '2fa' });
  });

  it('成功時は login_success（method 付き）を記録する', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId);
    await persistSession(session);

    await challengeVerify(request(session, { code: codeFor() }));
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    const success = events.find((e) => e.eventType === 'login_success');
    expect(success).toBeDefined();
    expect(success!.metadata).toMatchObject({ method: 'totp' });
  });

  it('既に昇格済みのセッションでの二重送信は 400（冪等にしない）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = { ...sessionFor(userId), totpPending: false };
    await persistSession(session);

    const response = await challengeVerify(request(session, { code: codeFor() }));
    expect(response.status).toBe(400);
  });
});
