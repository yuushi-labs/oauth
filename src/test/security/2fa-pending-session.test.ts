import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, sessions, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
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

import { GET as securityEvents } from '@/app/api/auth/security/events/route';
import { POST as linkStart } from '@/app/api/auth/oauth/link/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { GET as csrf } from '@/app/api/auth/csrf/route';
import { GET as me } from '@/app/api/auth/me/route';
import { POST as challengeVerify } from '@/app/api/auth/2fa/challenge/verify/route';
import { GET as status2fa } from '@/app/api/auth/2fa/route';

/**
 * §9.4 / D-33-08: 2FA 保留セッションは既定で封じ込める。ホワイトリストの 5 経路
 * （challenge/verify, logout, logout-all, csrf, me）だけが通る。
 */

const appUrl = 'http://localhost:3000';
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

function sessionFor(userId: string, totpPending: boolean): SessionData {
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
    totpPending,
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
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - 2FA pending session containment (D-33-08)', () => {
  it('保留セッションで GET /api/auth/security/events は 403 TOTP_REQUIRED', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await securityEvents(request('/api/auth/security/events', session, 'GET'));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('TOTP_REQUIRED');
  });

  it('保留セッションで GET /api/auth/2fa は 403 TOTP_REQUIRED', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await status2fa(request('/api/auth/2fa', session, 'GET'));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('TOTP_REQUIRED');
  });

  it('保留セッションで POST /api/auth/oauth/link は 403 TOTP_REQUIRED', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await linkStart(request('/api/auth/oauth/link', session, 'POST', { provider: 'github' }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('TOTP_REQUIRED');
  });

  it('保留セッションで POST /api/auth/logout は成功する（抜けられる）', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await logout(request('/api/auth/logout', session, 'POST'));
    expect(response.status).toBe(200);
  });

  it('保留セッションで GET /api/auth/csrf は成功する', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await csrf(request('/api/auth/csrf', session, 'GET'));
    expect(response.status).toBe(200);
    expect((await response.json()).data.csrfToken).toBe(deriveCsrfToken(session));
  });

  it('保留セッションで GET /api/auth/me は成功する（secret を返さない）', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    const response = await me(request('/api/auth/me', session, 'GET'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe(userId);
    expect(JSON.stringify(body)).not.toMatch(/secret|otpauth|recovery/i);
  });

  it('保留セッションでも challenge/verify は通る（昇格そのもの）', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, true);
    await persistSession(session);

    // 誤コードでも「保留セッションだから」403 にはならず、コード不一致の 400 になる
    const response = await challengeVerify(request('/api/auth/2fa/challenge/verify', session, 'POST', { code: '000000' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CODE');
  });

  it('昇格済みセッションは通常 API を通れる（対照）', async () => {
    const userId = await makeUser();
    const session = sessionFor(userId, false);
    await persistSession(session);

    const response = await status2fa(request('/api/auth/2fa', session, 'GET'));
    expect(response.status).toBe(200);
  });
});
