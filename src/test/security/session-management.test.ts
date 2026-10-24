// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';

const appUrl = 'http://localhost:3000';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

/** Route 側の認証SESSION（SessionData 形状） */
const session = {
  id: 'ses_current', userId: 'usr_owner', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: CHROME_UA, ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash-owner',
  deviceName: 'Chrome on Windows', reauthVerifiedAt: null, totpPending: false,
};

/** DB 行（sessions テーブルの形状）。Date を持つのでそのまま serialize できる。 */
const ownerRow = {
  id: 'ses_current', userId: 'usr_owner', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: CHROME_UA, ipHash: 'iphash-owner', ipMasked: '203.0.113.xxx', deviceName: 'Chrome on Windows',
  createdAt: new Date('2026-09-30T09:12:00Z'), lastSeenAt: new Date('2026-10-03T20:30:00Z'),
  expiresAt: new Date('2027-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2027-06-01T00:00:00Z'),
  revokedAt: null, replacedBy: null, revokeReason: null, reauthVerifiedAt: null, totpPending: false, passkeyPending: null,
};
const otherUserRow = { ...ownerRow, id: 'ses_other', userId: 'usr_other', userAgent: SAFARI_UA, deviceName: 'iPhone', ipMasked: '198.51.100.xxx' };
const activeSessions = [ownerRow, otherUserRow];

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return {
    ...actual,
    getSession: vi.fn(async () => session),
    revokeSession: vi.fn(async () => undefined),
    revokeAllSessions: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/auth/cookie', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/cookie')>('@/lib/auth/cookie');
  return { ...actual, clearSessionCookie: vi.fn(async () => undefined) };
});
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return { ...actual, findUserById: vi.fn(async () => ({ id: 'usr_owner', email: 'owner@example.com' })) };
});
vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
let reauthPass = true;
vi.mock('@/lib/auth/reauth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/reauth')>('@/lib/auth/reauth');
  return { ...actual, checkReauth: vi.fn(() => { if (!reauthPass) actual.checkReauth({ ...session, reauthVerifiedAt: null } as never); }) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: { check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })) },
}));

// セッション取得を実際の所有者条件で再現する
vi.mock('@/lib/db/queries/sessions', () => ({
  listActiveSessionsByUser: vi.fn(async (userId: string) => activeSessions.filter((row) => row.userId === userId)),
  findOwnedActiveSession: vi.fn(async (id: string, userId: string) =>
    activeSessions.find((row) => row.id === id && row.userId === userId) ?? null),
}));
vi.mock('@/lib/db/queries/user-preferences', () => ({
  getUserPreferences: vi.fn(async (userId: string) => ({ userId, theme: 'system', language: 'ja', timezone: 'UTC', updatedAt: new Date(0) })),
}));
vi.mock('@/lib/auth/email/templates', () => ({
  sendChangeNotificationEmail: vi.fn(async () => undefined),
  sendSecurityNotificationEmail: vi.fn(async () => undefined),
}));

import { GET as listSessions } from '@/app/api/auth/sessions/route';
import { DELETE as deleteSession } from '@/app/api/auth/sessions/[id]/route';
import { POST as logoutAll } from '@/app/api/auth/logout-all/route';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { revokeAllSessions, revokeSession } from '@/lib/auth/session';

function request(path: string, method: string, options: { csrf?: string; cookie?: string } = {}) {
  return new NextRequest(new Request(`${appUrl}${path}`, {
    method,
    headers: {
      origin: appUrl,
      ...(method === 'DELETE' || method === 'POST' ? { 'x-csrf-token': options.csrf ?? deriveCsrfToken(session) } : {}),
      cookie: options.cookie ?? 'auth_session=test-token',
    },
  }));
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.mocked(recordSecurityEvent).mockClear();
});

describe('Security - session management (spec 19 / 49)', () => {
  it('自分のセッションだけを返し、現在を先頭にする', async () => {
    const response = await listSessions(request('/api/auth/sessions', 'GET'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0].current).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('生 IP・user_agent・session_hash を返さない（spec 20 / 45）', async () => {
    const response = await listSessions(request('/api/auth/sessions', 'GET'));
    const body = await response.json();
    const row = body.data.sessions[0];
    expect(row.ip_masked).toBe('203.0.113.xxx');
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('user_agent');
    expect(row).not.toHaveProperty('session_hash');
    expect(row).not.toHaveProperty('csrf_secret');
  });

  it('自分のセッションは個別に失効できる', async () => {
    const response = await deleteSession(request('/api/auth/sessions/ses_current', 'DELETE'), context('ses_current'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ revoked: true, was_current: true });
    expect(recordSecurityEvent).toHaveBeenCalledWith('session_revoked', 'usr_owner', expect.any(String), expect.any(String), expect.anything());
  });

  it('★ 他人のセッション ID は 404（IDOR）。失効もされない', async () => {
    const response = await deleteSession(request('/api/auth/sessions/ses_other', 'DELETE'), context('ses_other'));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('存在しない ID は 404', async () => {
    const response = await deleteSession(request('/api/auth/sessions/ses_missing', 'DELETE'), context('ses_missing'));
    expect(response.status).toBe(404);
  });

  it('CSRF トークン欠落は 403（State-changing GET は不可）', async () => {
    const response = await deleteSession(
      new NextRequest(new Request(`${appUrl}/api/auth/sessions/ses_current`, {
        method: 'DELETE', headers: { origin: appUrl, cookie: 'auth_session=test-token' },
      })),
      context('ses_current'),
    );
    expect(response.status).toBe(403);
  });
});

describe('Security - logout-all requires reauthentication (spec 8)', () => {
  afterEach(() => vi.clearAllMocks());

  it('再認証なしは 401 REAUTH_REQUIRED。失効しない', async () => {
    reauthPass = false;
    const response = await logoutAll(request('/api/auth/logout-all', 'POST'));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('再認証済みなら全件失効して通知メールを送る', async () => {
    reauthPass = true;
    const response = await logoutAll(request('/api/auth/logout-all', 'POST'));
    expect(response.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith('usr_owner', 'logout_all');
    expect(recordSecurityEvent).toHaveBeenCalledWith('session_revoked', 'usr_owner', expect.any(String), expect.any(String), { all: true });
    const { sendChangeNotificationEmail } = await import('@/lib/auth/email/templates');
    expect(sendChangeNotificationEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ change: expect.stringContaining('ログアウト') }),
    );
  });
});