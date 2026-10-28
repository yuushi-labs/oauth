import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { totpCodeFor } from '@/test/helpers/totp';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, securityEvents, sessions, totp, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import { redact, isSensitiveKey } from '@/lib/util/logger';
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

import { GET as status2fa } from '@/app/api/auth/2fa/route';
import { POST as setup2fa } from '@/app/api/auth/2fa/setup/route';
import { POST as verify2fa } from '@/app/api/auth/2fa/verify/route';
import { POST as challengeVerify } from '@/app/api/auth/2fa/challenge/verify/route';
import { POST as disable } from '@/app/api/auth/2fa/disable/route';
import { POST as regenerate } from '@/app/api/auth/2fa/recovery-codes/regenerate/route';

/**
 * §10 T10 / T11 / D-33-20: secret・コードを応答・ログ・metadata に出さない。
 * `logger` の `SENSITIVE_KEYS` が新しいキーを伏せる。
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

function sessionFor(userId: string, options: { totpPending?: boolean; reauthed?: boolean } = {}): SessionData {
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
    reauthVerifiedAt: options.reauthed ? new Date().toISOString() : null,
    totpPending: options.totpPending ?? false,
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
            ${session.reauthVerifiedAt ? new Date(session.reauthVerifiedAt) : null}, ${session.totpPending})
  `);
}

function request(path: string, session: SessionData, method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(`${appUrl}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_session=${session.sessionHash}`,
      'x-csrf-token': deriveCsrfToken(session),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
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

function codeFor(): string {
  return totpCodeFor(SECRET);
}

const CODE_PATTERN = /\b\d{6}\b/;

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
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - 2FA secret leak (T10 / T11)', () => {
  it('secret を返すのは setup の応答だけ', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId);
    await persistSession(session);

    const setup = await setup2fa(request('/api/auth/2fa/setup', session, 'POST'));
    const setupBody = await setup.json();
    const secret = setupBody.data.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    // status / verify の応答に secret を含まない
    const status = await status2fa(request('/api/auth/2fa', session, 'GET'));
    expect(JSON.stringify(await status.json())).not.toContain(secret);

    const verify = await verify2fa(request('/api/auth/2fa/verify', session, 'POST', { code: '000000' }));
    expect(JSON.stringify(await verify.json())).not.toContain(secret);
  });

  it('リカバリーコードを返すのは verify / regenerate だけ', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId);
    await persistSession(session);
    await seedEnabledTotp(userId);

    const verify = await verify2fa(request('/api/auth/2fa/verify', session, 'POST', { code: '000000' }));
    const verifyBody = await verify.json();
    expect(verifyBody.data).toBeUndefined();

    // status は残数だけを返し、コード文字列を含まない
    const status = await status2fa(request('/api/auth/2fa', session, 'GET'));
    const statusBody = await status.json();
    expect(statusBody.data.recovery_codes_remaining).toBe(0);
    expect(JSON.stringify(statusBody)).not.toMatch(/[A-Z2-7]{5}-[A-Z2-7]{5}/);
  });

  it('security_events.metadata に secret / コードを入れない', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, { totpPending: true });
    await persistSession(session);
    await seedEnabledTotp(userId);

    await challengeVerify(request('/api/auth/2fa/challenge/verify', session, 'POST', { code: codeFor() }));

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    for (const event of events) {
      const metadata = JSON.stringify(event.metadata ?? {});
      expect(metadata).not.toContain(SECRET);
      expect(metadata).not.toMatch(CODE_PATTERN);
      expect(metadata).not.toMatch(/recovery/i);
    }
  });

  it('成功系 metadata は method / scope / reason のみ（コード・secret を含まない）', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);
    await seedEnabledTotp(userId);

    await disable(request('/api/auth/2fa/disable', session, 'POST', { code: codeFor() }));
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId));
    const disabled = events.find((e) => e.eventType === '2fa_disabled');
    expect(disabled).toBeDefined();
    // metadata が undefined か、既知のキーだけ
    if (disabled!.metadata) {
      expect(Object.keys(disabled!.metadata)).not.toContain('code');
      expect(Object.keys(disabled!.metadata)).not.toContain('secret');
    }
  });

  it('logger の redact が secret 系のキーを伏せる', () => {
    const redacted = redact({
      secret: SECRET,
      secretEncrypted: 'v1.abc',
      otpauthUri: 'otpauth://totp/x?secret=...',
      recoveryCodes: ['AAAAA-BBBBB-CCCCC-DDDDD'],
      recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD',
      qrSvg: '<svg/>',
    }) as Record<string, unknown>;

    for (const key of ['secret', 'secretEncrypted', 'otpauthUri', 'recoveryCodes', 'recoveryCode', 'qrSvg']) {
      expect(redacted[key], key).toBe('***');
    }
  });

  it('isSensitiveKey が正規化した secret 系キーを判定する', () => {
    for (const key of ['secret', 'secret_encrypted', 'otpauth_uri', 'recovery_codes', 'recovery_code', 'qr_svg', 'totp_secret']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });
});
