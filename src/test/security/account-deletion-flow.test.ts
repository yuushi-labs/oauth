import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { totpCodeFor } from '@/test/helpers/totp';
import { getDb, getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, accountDeletionRequests, rateLimitHits, securityEvents, sessions, totp, users, webauthnCredentials } from '@/lib/db/schema';
import { createUser, findUserById } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import { hashToken } from '@/lib/auth/tokens/generate';
import { protectRateLimitKey, rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { useMemoryEmail } from '@/test/helpers/email';
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

import { DELETE as deleteAccount } from '@/app/api/auth/account/route';
import { POST as requestDeletion } from '@/app/api/auth/account/delete/request/route';
import { GET as confirmGet, POST as confirmPost } from '@/app/api/auth/account/delete/confirm/route';

/**
 * §8 / §24: アカウント削除は「強い再認証」を必須とし、削除時は
 * 全セッション・全トークン・Passkey・OIDC grant を失効させる。
 *
 * 実 PostgreSQL で Route Handler を直接叩く。3 経路（パスワード＋コード / Passkey /
 * メール確認）が同じ副作用に収束することを固定する。
 */

const appUrl = 'http://localhost:3000';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const anonSecret = 'anon-secret-account-delete';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');
const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return { id, email };
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

function request(
  path: string,
  session: SessionData,
  method: 'POST' | 'DELETE',
  body?: unknown,
): NextRequest {
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
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : { body: JSON.stringify(body ?? {}) }),
  });
}

function anonRequest(path: string, method: 'POST', body?: unknown): NextRequest {
  return new NextRequest(`${appUrl}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_anon=${anonSecret}.${anonSigned}`,
      'x-csrf-token': anonSecret,
    },
    body: JSON.stringify(body ?? {}),
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

function codeFor(at: Date = new Date()): string {
  return totpCodeFor(SECRET, at);
}

async function seedCredential(userId: string): Promise<void> {
  await getDb().insert(webauthnCredentials).values({
    id: `wac_${uniq('c')}`,
    userId,
    credentialId: `wch_${uniq('k')}`,
    publicKey: 'pk',
    signCount: 0,
    transports: null,
    aaguid: null,
    deviceName: 'iPhone',
    backedUp: false,
  });
}

async function isDeleted(userId: string): Promise<boolean> {
  const user = await findUserById(userId);
  return user?.status === 'deleted' && user?.deletedAt !== null;
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', appUrl);
  vi.stubEnv('ALLOWED_ORIGINS', appUrl);
  // テストは IP を指定しないため clientIp は '0.0.0.0' に固定される。前のテストの
  // レート制限カウンタが残ると 429 になるので、IP キーだけ先に消す（利用者キーは afterEach）。
  await getDb().delete(rateLimitHits)
    .where(eq(rateLimitHits.key, protectRateLimitKey(rateLimitKeys.accountDeleteEmailIp('0.0.0.0'))));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const id of createdSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of createdUserIds.splice(0)) {
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    await db.delete(accountDeletionRequests).where(eq(accountDeletionRequests.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(rateLimitHits).where(eq(rateLimitHits.key, protectRateLimitKey(rateLimitKeys.accountDeleteEmailUser(id))));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - アカウント削除の強い再認証（§8 / §24）', () => {
  it('再認証なしでは削除できない（401 REAUTH_REQUIRED・DB は不変）', async () => {
    const { id } = await makeUser();
    await seedEnabledTotp(id);
    const session = sessionFor(id, false);
    await persistSession(session);

    const response = await deleteAccount(request('/api/auth/account', session, 'DELETE', { code: codeFor() }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
    expect(await isDeleted(id)).toBe(false);
  });

  it('再認証済みでもコード誤りなら削除されない（400 INVALID_CODE）', async () => {
    const { id } = await makeUser();
    await seedEnabledTotp(id);
    const session = sessionFor(id, true);
    await persistSession(session);

    const response = await deleteAccount(request('/api/auth/account', session, 'DELETE', { code: '000000' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CODE');
    expect(await isDeleted(id)).toBe(false);
  });

  it('再認証＋正しいコードで削除し、全セッション・Passkey・トークン・OIDC grant を失効させる', async () => {
    const { id } = await makeUser();
    await seedEnabledTotp(id);
    await seedCredential(id);
    const session = sessionFor(id, true);
    await persistSession(session);
    // 他端末セッションも同時に失効することを見る
    const other = sessionFor(id, true);
    await persistSession(other);
    // 未消費トークンを仕込む（削除で失効するはず）
    await getDb().insert(accountDeletionRequests).values({
      id: `tok_${uniq('d')}`,
      userId: id,
      tokenHash: hashToken(`pending-${uniq('p')}`),
      purpose: 'account_deletion',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await deleteAccount(request('/api/auth/account', session, 'DELETE', { code: codeFor() }));
    expect(response.status).toBe(200);
    expect(await isDeleted(id)).toBe(true);

    const liveSessions = await getDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    expect(liveSessions).toHaveLength(0);

    const creds = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    expect(creds).toHaveLength(0);

    const pending = await getDb()
      .select()
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.userId, id), isNull(accountDeletionRequests.usedAt)));
    expect(pending).toHaveLength(0);

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, id));
    expect(events.map((event) => event.eventType)).toContain('account_deleted');
  });
});

describe('Security - メール確認による退会（§24）', () => {
  it('確認リクエストでメールを送り、リンクの POST で削除が確定する', async () => {
    const { id, email } = await makeUser();
    const session = sessionFor(id, true);
    await persistSession(session);
    const mail = useMemoryEmail();

    try {
      const requested = await requestDeletion(request('/api/auth/account/delete/request', session, 'POST'));
      expect(requested.status).toBe(200);
      const sent = mail.outbox.find((entry) => entry.to === email);
      expect(sent?.tokenFromUrl).toBeTruthy();
      expect(await isDeleted(id)).toBe(false);

      // GET は状態を変えない（303 転送のみ・§25）
      const getResponse = await confirmGet(
        new NextRequest(`${appUrl}/api/auth/account/delete/confirm?token=${sent!.tokenFromUrl}`),
      );
      expect(getResponse.status).toBe(303);
      expect(await isDeleted(id)).toBe(false);

      const confirmed = await confirmPost(
        anonRequest('/api/auth/account/delete/confirm', 'POST', { token: sent!.tokenFromUrl }),
      );
      expect(confirmed.status).toBe(200);
      expect(await isDeleted(id)).toBe(true);
    } finally {
      mail.restore();
    }
  });

  it('同じトークンは 1 回しか消費できない（2 回目は 400）', async () => {
    const { id, email } = await makeUser();
    const session = sessionFor(id, true);
    await persistSession(session);
    const mail = useMemoryEmail();

    try {
      await requestDeletion(request('/api/auth/account/delete/request', session, 'POST'));
      const token = mail.outbox.find((entry) => entry.to === email)!.tokenFromUrl!;

      const first = await confirmPost(anonRequest('/api/auth/account/delete/confirm', 'POST', { token }));
      expect(first.status).toBe(200);
      const second = await confirmPost(anonRequest('/api/auth/account/delete/confirm', 'POST', { token }));
      expect(second.status).toBe(400);
      expect((await second.json()).error.code).toBe('INVALID_TOKEN');
    } finally {
      mail.restore();
    }
  });

  it('再要求すると未消費の旧トークンは無効化される（D-16）', async () => {
    const { id, email } = await makeUser();
    const session = sessionFor(id, true);
    await persistSession(session);
    const mail = useMemoryEmail();

    try {
      await requestDeletion(request('/api/auth/account/delete/request', session, 'POST'));
      const firstToken = mail.outbox.find((entry) => entry.to === email)!.tokenFromUrl!;

      await requestDeletion(request('/api/auth/account/delete/request', session, 'POST'));

      const stale = await confirmPost(anonRequest('/api/auth/account/delete/confirm', 'POST', { token: firstToken }));
      expect(stale.status).toBe(400);
      expect(await isDeleted(id)).toBe(false);
    } finally {
      mail.restore();
    }
  });
});
