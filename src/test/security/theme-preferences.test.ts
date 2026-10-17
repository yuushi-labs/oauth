// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';

const appUrl = 'http://localhost:3000';
const session = {
  id: 'ses_1', userId: 'usr_1', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: 'Chrome', ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash',
  deviceName: 'Chrome on Windows', reauthVerifiedAt: null,
};

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => session) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: { check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })) },
}));
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return { ...actual, findUserById: vi.fn(async () => ({ id: 'usr_1', email: 'user@example.com' })) };
});

let stored: Record<string, unknown> | null = null;
vi.mock('@/lib/db/queries/user-preferences', () => ({
  getUserPreferences: vi.fn(async (userId: string) => stored ?? ({ userId, theme: 'system', language: 'ja', timezone: 'UTC', updatedAt: new Date(0) })),
  upsertUserPreferences: vi.fn(async (userId: string, patch: Record<string, unknown>) => {
    stored = { userId, ...(stored ?? { language: 'ja', timezone: 'UTC' }), ...patch, updatedAt: new Date() };
    return stored;
  }),
}));

import { GET as getPreferences, PATCH as patchPreferences } from '@/app/api/auth/preferences/route';

function request(method: string, body?: unknown, csrf?: string) {
  return new NextRequest(new Request(`${appUrl}/api/auth/preferences`, {
    method,
    headers: {
      origin: appUrl,
      'content-type': 'application/json',
      cookie: 'auth_session=test',
      ...(method === 'PATCH' ? { 'x-csrf-token': csrf ?? deriveCsrfToken(session) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

beforeEach(() => {
  stored = null;
  vi.clearAllMocks();
});

afterEach(() => {
  stored = null;
});

describe('Security - user preferences (spec 40)', () => {
  it('行が無い場合は既定（system/ja/UTC）を返す', async () => {
    const response = await getPreferences(request('GET'));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ theme: 'system', language: 'ja', timezone: 'UTC' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('theme を更新できる', async () => {
    const response = await patchPreferences(request('PATCH', { theme: 'dark' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.theme).toBe('dark');
    const { upsertUserPreferences } = await import('@/lib/db/queries/user-preferences');
    expect(upsertUserPreferences).toHaveBeenCalledWith('usr_1', { theme: 'dark' });
  });

  it('往復: PATCH 後に GET が同じ値を返す', async () => {
    await patchPreferences(request('PATCH', { theme: 'light' }));
    const response = await getPreferences(request('GET'));
    expect((await response.json()).data.theme).toBe('light');
  });

  it('★ 不正な theme は 400（_enum 制約）', async () => {
    const response = await patchPreferences(request('PATCH', { theme: 'neon' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('未知キーは 400（strict）', async () => {
    const response = await patchPreferences(request('PATCH', { theme: 'dark', admin: true }));
    expect(response.status).toBe(400);
  });

  it('CSRF トークン欠落は 403', async () => {
    const response = await patchPreferences(
      new NextRequest(new Request(`${appUrl}/api/auth/preferences`, {
        method: 'PATCH', headers: { origin: appUrl, 'content-type': 'application/json', cookie: 'auth_session=test' },
        body: JSON.stringify({ theme: 'dark' }),
      })),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_FAILED');
  });

  it('★ 別ユーザーの userId を pita しても更新されない（spec 49）', async () => {
    const response = await patchPreferences(request('PATCH', { theme: 'dark', userId: 'usr_other' }));
    expect(response.status).toBe(400);
    const { upsertUserPreferences } = await import('@/lib/db/queries/user-preferences');
    expect(vi.mocked(upsertUserPreferences)).not.toHaveBeenCalled();
  });

  it('保存先は常に自分の userId（サーバー側のセッション由来）', async () => {
    await patchPreferences(request('PATCH', { theme: 'dark' }));
    const { upsertUserPreferences } = await import('@/lib/db/queries/user-preferences');
    expect(vi.mocked(upsertUserPreferences).mock.calls.at(-1)?.[0]).toBe('usr_1');
  });

  it('未ログインは 401', async () => {
    const { getSession } = await import('@/lib/auth/session');
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await getPreferences(new NextRequest(new Request(`${appUrl}/api/auth/preferences`)));
    expect(response.status).toBe(401);
  });
});