import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
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

import { POST as disable } from '@/app/api/auth/2fa/disable/route';
import { POST as regenerate } from '@/app/api/auth/2fa/recovery-codes/regenerate/route';

/**
 * §8.5 / §8.6 / D-33-14 / D-33-23: 無効化・再生成は「パスワード再認証 ＋ 現在のコード」を要求する。
 * 検証に失敗したら DB を変更しない（T23）。セッション窃取だけでは外せない（T22）。
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

function sessionFor(userId: string, reauthed: boolean): SessionData {
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
    reauthVerifiedAt: reauthed ? new Date().toISOString() : null,
    totpPending: false,
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
            ${session.reauthVerifiedAt ? new Date(session.reauthVerifiedAt) : null}, false)
  `);
}

function request(path: string, session: SessionData, body: unknown): NextRequest {
  return new NextRequest(`${appUrl}${path}`, {
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
  return new TOTP({ secret: Secret.fromBase32(SECRET), algorithm: 'SHA1', digits: 6, period: 30 })
    .generate({ timestamp: at.getTime() });
}

async function totpRow(userId: string) {
  const [row] = await getDb().select().from(totp).where(eq(totp.userId, userId));
  return row ?? null;
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

describe('Security - 2fa disable requires strong reauth (D-33-23 / T22)', () => {
  it('再認証なし（セッション窃取のみ）では無効化できない（401 REAUTH_REQUIRED）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId, false);
    await persistSession(session);

    const response = await disable(request('/api/auth/2fa/disable', session, { code: codeFor() }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
    expect((await totpRow(userId))!.enabled).toBe(true);
  });

  it('再認証済みでもコード誤りなら無効化されない（400 INVALID_CODE）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await disable(request('/api/auth/2fa/disable', session, { code: '000000' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CODE');
    expect((await totpRow(userId))!.enabled).toBe(true);
  });

  it('T23: 再認証未了なら正しいコードでも消費されず、再認証後に同じコードで通る', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const notReauthed = sessionFor(userId, false);
    await persistSession(notReauthed);

    const code = codeFor();
    const first = await disable(request('/api/auth/2fa/disable', notReauthed, { code }));
    expect(first.status).toBe(401);
    // counter は消費されていない（checkReauth がコード検証より先に落ちる）
    expect((await totpRow(userId))!.lastUsedCounter).toBe(-1);

    // 再認証済みセッションで同じコードを使って無効化できる
    const reauthed = sessionFor(userId, true);
    await persistSession(reauthed);
    const second = await disable(request('/api/auth/2fa/disable', reauthed, { code }));
    expect(second.status).toBe(200);
    expect(await totpRow(userId)).toBeNull();
  });

  it('再認証済み ＋ 正しいコードで無効化し、2fa_disabled を記録する', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await disable(request('/api/auth/2fa/disable', session, { code: codeFor() }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ enabled: false });

    expect(await totpRow(userId)).toBeNull();
    const codes = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    expect(codes).toHaveLength(0);

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    expect(events.map((e) => e.eventType)).toContain('2fa_disabled');
  });

  it('リカバリーコードでも無効化できる', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const codes = await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await disable(request('/api/auth/2fa/disable', session, { code: codes[0] }));
    expect(response.status).toBe(200);
    expect(await totpRow(userId)).toBeNull();
  });
});

describe('Security - recovery code regenerate (D-33-23)', () => {
  it('再認証 ＋ 正しいコードで再生成し、旧コードが無効になる', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    const oldCodes = await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await regenerate(
      request('/api/auth/2fa/recovery-codes/regenerate', session, { code: codeFor() }),
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.recovery_codes).toHaveLength(10);

    // 旧コードは削除されている（残っているのは新しい 10 個だけ）
    const stored = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    expect(stored).toHaveLength(10);
    for (const old of oldCodes) {
      expect(stored.some((r) => r.codeHash === hashRecoveryCode(normalizeRecoveryCode(old)))).toBe(false);
    }
    // TOTP は有効のまま
    expect((await totpRow(userId))!.enabled).toBe(true);

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    const regenerated = events.find((e) => e.eventType === '2fa_enabled');
    expect(regenerated?.metadata).toMatchObject({ reason: 'regenerated' });
  });

  it('再認証なしでは再生成できない（401 REAUTH_REQUIRED）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId, false);
    await persistSession(session);

    const response = await regenerate(
      request('/api/auth/2fa/recovery-codes/regenerate', session, { code: codeFor() }),
    );
    expect(response.status).toBe(401);
    // 既存コードは残ったまま
    const stored = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    expect(stored).toHaveLength(5);
  });

  it('コード誤りでは再生成されない（400 INVALID_CODE）', async () => {
    const userId = await makeUser();
    await seedEnabledTotp(userId);
    await seedRecoveryCodes(userId, 5);
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await regenerate(
      request('/api/auth/2fa/recovery-codes/regenerate', session, { code: '000000' }),
    );
    expect(response.status).toBe(400);
    const stored = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    expect(stored).toHaveLength(5);
  });
});
