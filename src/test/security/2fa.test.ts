import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { sha256Hex } from '@/lib/util/crypto';
import type { SessionData } from '@/lib/auth/session';

// Route Handler の cookie 書込みは request scope 外だと throw するため差し替える（D-32-17 / BUG-15）。
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
import { POST as login } from '@/app/api/auth/login/route';

/**
 * §8.1〜§8.3 / §8.7: 2FA の状態取得・setup・verify とログインの 2 段階化。
 * 実 DB を使い、Route Handler を直接叩く（pipeline が実セッションを解決する）。
 */

const appUrl = 'http://localhost:3000';
const anonSecret = 'anon-secret-2fa-setup';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(options: { emailVerified?: boolean } = {}): Promise<{ id: string; email: string; username: string }> {
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  const username = uniq('u');
  await createUser({
    id,
    username,
    email,
    emailVerified: options.emailVerified ?? true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: options.emailVerified === false ? 'pending_email' : 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return { id, email, username };
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

function authedRequest(path: string, session: SessionData | null, method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(`${appUrl}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      ...(session
        ? { cookie: `auth_session=${session.sessionHash}`, 'x-csrf-token': deriveCsrfToken(session) }
        : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
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

async function seedTotp(userId: string, secretBase32: string, enabled: boolean): Promise<void> {
  await getDb().insert(totp).values({
    userId,
    secretEncrypted: encryptTotpSecret(secretBase32),
    enabled,
    lastUsedCounter: -1,
  });
}

function codeFor(secretBase32: string, at: Date = new Date()): string {
  return new TOTP({ secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
    .generate({ timestamp: at.getTime() });
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

afterAll(() => undefined);

describe('2fa setup (spec 48 / D-33-06 / D-33-16)', () => {
  it('未確認 email では setup できない（403 EMAIL_NOT_VERIFIED）', async () => {
    const user = await makeUser({ emailVerified: false });
    const session = sessionFor(user.id);
    await persistSession(session);

    const response = await setup2fa(authedRequest('/api/auth/2fa/setup', session, 'POST'));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('setup 成功で secret / otpauth_uri / qr_svg が返る（secret を返すのはこの 1 回だけ）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);

    const response = await setup2fa(authedRequest('/api/auth/2fa/setup', session, 'POST'));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(data.otpauth_uri.startsWith('otpauth://totp/')).toBe(true);
    expect(data.otpauth_uri).toContain(`secret=${data.secret}`);
    expect(data.qr_svg).toContain('<svg');

    // DB には暗号文で保存され、平文は含まない
    const [row] = await getDb().select().from(totp).where(eq(totp.userId, user.id));
    expect(row!.enabled).toBe(false);
    expect(row!.secretEncrypted).not.toContain(data.secret);
  });

  it('有効化済みで setup を呼ぶと 409 TOTP_ALREADY_ENABLED', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);
    await seedTotp(user.id, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', true);

    const response = await setup2fa(authedRequest('/api/auth/2fa/setup', session, 'POST'));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TOTP_ALREADY_ENABLED');
  });

  it('保留セッションでは setup できない（403 TOTP_REQUIRED・D-33-08）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { totpPending: true });
    await persistSession(session);

    const response = await setup2fa(authedRequest('/api/auth/2fa/setup', session, 'POST'));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('TOTP_REQUIRED');
  });
});

describe('2fa verify (spec 48 / §8.3)', () => {
  it('正しいコードで有効化し、リカバリーコードを 10 個返す', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await seedTotp(user.id, secret, false);

    const response = await verify2fa(authedRequest('/api/auth/2fa/verify', session, 'POST', { code: codeFor(secret) }));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.enabled).toBe(true);
    expect(data.recovery_codes).toHaveLength(10);

    const [row] = await getDb().select().from(totp).where(eq(totp.userId, user.id));
    expect(row!.enabled).toBe(true);
    expect(row!.confirmedAt).not.toBeNull();

    const stored = await getDb().select().from(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
    expect(stored).toHaveLength(10);
    // 保存は hash のみ（平文は残さない）
    for (const code of data.recovery_codes) {
      expect(stored.some((r) => r.codeHash === sha256Hex(code.replace(/-/g, '')))).toBe(true);
    }

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(events.map((e) => e.eventType)).toContain('2fa_enabled');
  });

  it('誤ったコードは 400 INVALID_CODE で enabled は false のまま', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await seedTotp(user.id, secret, false);

    const response = await verify2fa(authedRequest('/api/auth/2fa/verify', session, 'POST', { code: '000000' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CODE');

    const [row] = await getDb().select().from(totp).where(eq(totp.userId, user.id));
    expect(row!.enabled).toBe(false);
  });
});

describe('GET /2fa (spec 48 / §8.1)', () => {
  it('無効時は enabled=false / 残数 0 / strong_reauth_methods=["password"]', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);

    const response = await status2fa(authedRequest('/api/auth/2fa', session, 'GET'));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.enabled).toBe(false);
    expect(data.recovery_codes_remaining).toBe(0);
    expect(data.strong_reauth_methods).toEqual(['password']);
  });

  it('有効時は enabled=true と未使用リカバリーコードの残数を返す', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    await persistSession(session);
    await seedTotp(user.id, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', true);
    await getDb().insert(recoveryCodes).values([
      { id: `tok_${uniq('r')}`, userId: user.id, codeHash: sha256Hex('AAA') },
      { id: `tok_${uniq('r')}`, userId: user.id, codeHash: sha256Hex('BBB') },
    ]);

    const response = await status2fa(authedRequest('/api/auth/2fa', session, 'GET'));
    const { data } = await response.json();
    expect(data.enabled).toBe(true);
    expect(data.recovery_codes_remaining).toBe(2);
  });
});

describe('login の 2 段階化 (spec 48 / §8.7 / D-33-07)', () => {
  it('2FA 無効なら応答は従来どおり（{ message } でセッション発行）', async () => {
    const user = await makeUser();
    const response = await login(loginRequest(user.email, 'Strong-Password-2026!'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ message: 'ログインしました' });
  });

  it('2FA 有効なら保留セッションを発行し { twoFactorRequired: true } を返す', async () => {
    const user = await makeUser();
    await seedTotp(user.id, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', true);

    const response = await login(loginRequest(user.email, 'Strong-Password-2026!'));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ twoFactorRequired: true });

    const rows = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totpPending).toBe(true);

    // 保留段階では login_success を記録しない（T14）
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(events.map((e) => e.eventType)).not.toContain('login_success');
  });
});
