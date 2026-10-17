import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const appUrl = 'http://localhost:3000';
const TEST_USER_ID = `usr_secevts_${Date.now().toString(36)}`;
const session = {
  id: 'ses_1', userId: TEST_USER_ID, sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: 'Chrome', ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash',
  deviceName: 'Chrome on Windows', reauthVerifiedAt: null,
};

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => session) };
});
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return { ...actual, findUserById: vi.fn(async () => ({ id: TEST_USER_ID, email: 'user@example.com' })) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: { check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })) },
}));

// allowlist の実挙動を検証するため、DB 版の実クエリはそのまま使う
vi.mock('@/lib/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/client')>('@/lib/db/client');
  return { ...actual };
});

import { getPool } from '@/lib/db/client';
import { listRecentSecurityEventsByUser as realListEvents } from '@/lib/db/queries/security-events';
import { GET as listEvents } from '@/app/api/auth/security/events/route';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';

let listSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, `secevts_${Date.now().toString(36)}`, `secevts-${Date.now().toString(36)}@example.com`,
     await hashPassword('Security-Events-Strong-2026!'), DEFAULT_ROLE_ID],
  );
  listSpy = vi.spyOn(await import('@/lib/db/queries/security-events'), 'listRecentSecurityEventsByUser');
});

afterAll(async () => {
  await getPool().query('DELETE FROM security_events WHERE user_id = $1', [TEST_USER_ID]);
  await getPool().query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]);
});

function request(path: string) {
  return new NextRequest(new Request(`${appUrl}${path}`, { headers: { origin: appUrl, cookie: 'auth_session=test' } }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  // テスト用のイベントを投入し、実クエリをそのまま通す
  await getPool().query('DELETE FROM security_events WHERE user_id = $1', [TEST_USER_ID]);
  await getPool().query(
    `INSERT INTO security_events (id, user_id, event_type, ip, ip_masked, user_agent, metadata, created_at)
     VALUES ($1, $2, 'login_success', '203.0.113.10', '203.0.113.xxx', 'Chrome/140',
             '{"device":"Chrome on Windows"}'::jsonb, now()),
            ($3, $2, 'login_failed', '198.51.100.20', '198.51.100.xxx', 'curl/8',
             '{}'::jsonb, now() - interval '1 minute')`,
    [`evt_se_${Date.now().toString(36)}`, TEST_USER_ID, `evt_se_${(Date.now() + 1).toString(36)}`],
  );
  listSpy.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe('Security - security events API (spec 21 / 37)', () => {
  it('本人宛のイベントだけを返す', async () => {
    const response = await listEvents(request('/api/auth/security/events'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events[0].event_type).toBe('login_success');
  });

  it('★ 生 IP・user_agent を返さない（spec 20 / 45）', async () => {
    const response = await listEvents(request('/api/auth/security/events'));
    const row = (await response.json()).data.events[0];
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('user_agent');
    expect(row.ip_masked).toBe('203.0.113.xxx');
  });

  it('no-store を付ける（§45: 機密.handling）', async () => {
    const response = await listEvents(request('/api/auth/security/events'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('limit が既定 10・上限 50 に丸められる', async () => {
    await listEvents(request('/api/auth/security/events?limit=100'));
    expect(listSpy.mock.calls.at(-1)?.[1]).toBe(50);

    await listEvents(request('/api/auth/security/events?limit=0'));
    expect(listSpy.mock.calls.at(-1)?.[1]).toBe(10);

    await listEvents(request('/api/auth/security/events?limit=abc'));
    expect(listSpy.mock.calls.at(-1)?.[1]).toBe(10);

    await listEvents(request('/api/auth/security/events?limit=3'));
    expect(listSpy.mock.calls.at(-1)?.[1]).toBe(3);
  });

  it('★ 読み取り専用 GET（行を追加しない・§25）', async () => {
    const before = await getPool().query('SELECT count(*)::int AS c FROM security_events WHERE user_id = $1', [TEST_USER_ID]);
    await listEvents(request('/api/auth/security/events'));
    const after = await getPool().query('SELECT count(*)::int AS c FROM security_events WHERE user_id = $1', [TEST_USER_ID]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('未ログインは 401', async () => {
    const { getSession } = await import('@/lib/auth/session');
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await listEvents(request('/api/auth/security/events'));
    expect(response.status).toBe(401);
  });
});

describe('Security - security events query filters metadata (spec 45)', () => {
  it('許可キー以外の metadata は落ちる', async () => {
    await getPool().query('DELETE FROM security_events WHERE user_id = $1', [TEST_USER_ID]);
    await getPool().query(
      `INSERT INTO security_events (id, user_id, event_type, ip, ip_masked, user_agent, metadata, created_at)
       VALUES ($1, $2, 'login_success', '203.0.113.9', '203.0.113.xxx', 'SecretUA',
               '{"device":"Chrome","session_token":"leaked-secret","state":"oauth-state"}'::jsonb, now())`,
      [`evt_allow_${Date.now().toString(36)}`, TEST_USER_ID],
    );

    const rows = await realListEvents(TEST_USER_ID, 10);
    const row = rows[0]!;
    expect(row.ipMasked).toBe('203.0.113.xxx');
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('userAgent');
    expect(row.metadata).toEqual({ device: 'Chrome' });
    expect(JSON.stringify(row)).not.toContain('leaked-secret');
    expect(JSON.stringify(row)).not.toContain('oauth-state');
  });
});