// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { useMemoryEmail, restoreResendEmail } from '@/test/helpers/email';

const appUrl = 'http://localhost:3000';
const session = {
  id: 'ses_1', userId: 'usr_1', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: 'Chrome', ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash-1',
  deviceName: 'Chrome on Windows', reauthVerifiedAt: null,
};

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return {
    ...actual,
    getSession: vi.fn(async () => session),
    // セッション発行は決定論的にし、(ip_hash, device_name) の判定をテストできる形にする
    createSession: vi.fn(async () => ({
      token: 'sess_token',
      session: {
        ...session,
        id: 'ses_new',
        ip: '203.0.113.10',
        ipMasked: '203.0.113.xxx',
        ipHash: 'iphash-new',
        deviceName: 'Chrome on Windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
      },
    })),
  };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })),
    reserveFailedAttempt: vi.fn(async () => ({ allowed: true, reservation: { id: 'res_1' } })),
    finishFailedAttempt: vi.fn(async () => false),
    releaseReservation: vi.fn(async () => undefined),
  },
}));
vi.mock('@/lib/auth/breached', () => ({ checkBreached: vi.fn(async () => ({ breached: false, failOpen: false })) }));
vi.mock('@/lib/auth/captcha', () => ({ verifyCaptchaIfRequired: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/password', () => ({ hashPassword: vi.fn(async () => 'hash'), verifyPassword: vi.fn(async () => true) }));
vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return {
    ...actual,
    findUserByEmailOrUsername: vi.fn(async () => ({
      id: 'usr_1', email: 'user@example.com', passwordHash: 'hash', status: 'active', emailVerified: true,
    })),
    createUser: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/auth/tokens/generate', () => ({
  generateToken: vi.fn(() => ({ raw: 'token-raw', hash: 'token-hash', id: 'tok_1' })),
}));
vi.mock('@/lib/db/queries/tokens', () => ({
  insertEmailVerificationToken: vi.fn(async () => undefined),
  invalidateEmailVerificationTokens: vi.fn(async () => undefined),
}));
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

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  getDb: () => ({ insert: () => ({ values: async () => undefined }) }),
}));

type FakeSessionRow = { id: string; ipHash: string | null; deviceName: string | null };
const activeSessions: FakeSessionRow[] = [];
vi.mock('@/lib/db/queries/sessions', () => ({
  listActiveSessionsByUser: vi.fn(async () => activeSessions),
}));

import { POST as login } from '@/app/api/auth/login/route';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { isFirstSessionFromDevice } from '@/lib/auth/notifications';

// login は未ログイン経路なので anon cookie + 匹配的 CSRF トークンが必要
const anonSecret = 'anon-secret-new-device';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');

function loginRequest() {
  return new NextRequest(new Request(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ email_or_username: 'user@example.com', password: 'Strong-Password-2026!' }),
  }));
}

let mail: ReturnType<typeof useMemoryEmail>;

beforeEach(() => {
  activeSessions.length = 0;
  mail = useMemoryEmail();
  vi.clearAllMocks();
});

afterEach(() => {
  restoreResendEmail();
});

describe('Security - new device notification (spec 18)', () => {
  it('初回（他の有効セッションが無い）は通知を送る', async () => {
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.subject).toContain('新しいログイン');
    expect(mail.outbox[0]!.html).toContain('Chrome on Windows');
    expect(recordSecurityEvent).toHaveBeenCalledWith('new_device_login', 'usr_1', expect.any(String), expect.any(String), expect.anything());
  });

  it('★ 通知本文にPW/token/TOTP/session を含まない（spec 18 / 45）', async () => {
    await login(loginRequest());
    const body = mail.outbox[0]!.html + mail.outbox[0]!.text;
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/totp|recovery/i);
    expect(body).not.toContain('csrf');
  });

  it('同じ device_name と ip_hash の既存セッションがあれば通知しない', async () => {
    activeSessions.push({ id: 'ses_old', ipHash: 'iphash-new', deviceName: 'Chrome on Windows' });
    await login(loginRequest());
    expect(mail.outbox).toHaveLength(0);
  });

  it('別のデバイスなら通知する', async () => {
    activeSessions.push({ id: 'ses_old', ipHash: 'iphash-new', deviceName: 'iPhone' });
    await login(loginRequest());
    expect(mail.outbox).toHaveLength(1);
  });

  it('失効済みセッションは判定材料にしない', async () => {
    const { listActiveSessionsByUser } = await import('@/lib/db/queries/sessions');
    vi.mocked(listActiveSessionsByUser).mockResolvedValueOnce([]);
    const first = await isFirstSessionFromDevice('usr_1', 'ses_new', 'iphash-new', 'Chrome on Windows');
    expect(first).toBe(true);
  });

  it('★ 通知の送信失敗で login が失敗しない（200 のまま）', async () => {
    mail.failNext();
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      'security_notification_failed', 'usr_1', expect.any(String), expect.any(String), { kind: 'security_notification' },
    );
  });

  it('判定に 5 分以内の再認証は不要（login は reauth  exempt）', async () => {
    const response = await login(loginRequest());
    expect(response.status).not.toBe(401);
  });
});