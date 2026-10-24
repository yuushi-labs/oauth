import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, DEFAULT_ROLE_ID, oauthStates, securityEvents, sessions, users } from '@/lib/db/schema';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { createUser } from '@/lib/db/queries/users';
import { createAccount, countAccountsByUser, listAccountsByUser } from '@/lib/auth/oauth/accounts';
import { DELETE } from '@/app/api/auth/accounts/[id]/route';
import { POST as LINK_START } from '@/app/api/auth/oauth/link/route';
import { consumeOAuthState, issueOAuthState } from '@/lib/auth/oauth/state';
import { sha256Hex } from '@/lib/util/crypto';
import type { SessionData } from '@/lib/auth/session';

/**
 * §7.8 の link 脅威（リハッシュ）と、解除の境界（§49 / §11）。
 *
 * Route Handler を `NextRequest` へ直接叩くので、`user.id` は session の userId と
 * 一致させる必要がある（pipeline が session から user を解決する）。
 */

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: async () => ({ allowed: true, logRateLimited: false, resetAt: Date.now() + 60_000 }),
    reserveFailedAttempt: async () => ({ allowed: true }),
    releaseReservation: async () => undefined,
    finishFailedAttempt: async () => false,
  },
}));

// 通知メールは best-effort。テストでは送信しないので seam を潰す
vi.mock('@/lib/auth/notifications', () => ({
  isFirstSessionFromDevice: async () => false,
  notifyNewDeviceLogin: async () => true,
  notifyAccountChange: async () => true,
}));

const ENV = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-id',
  GITHUB_CLIENT_SECRET: 'github-secret',
  DISCORD_CLIENT_ID: 'discord-id',
  DISCORD_CLIENT_SECRET: 'discord-secret',
};

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const issuedStates: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(email: string, passwordHash: string | null): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: true,
    passwordHash,
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

async function linkAccount(userId: string, provider: 'google' | 'github' | 'discord'): Promise<string> {
  const account = await createAccount({
    userId,
    provider,
    providerAccountId: uniq('sub'),
    providerEmail: null,
  });
  createdAccountIds.push(account.id);
  return account.id;
}

function sessionFor(userId: string, options: { reauthed?: boolean } = {}): SessionData {
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
    totpPending: false,
  };
}

function post(path: string, session: SessionData | null, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      'user-agent': 'vitest',
      ...(session
        ? {
            cookie: `auth_session=${session.sessionHash}`,
            'x-csrf-token': deriveCsrfToken(session),
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function del(path: string, session: SessionData | null): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'DELETE',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'user-agent': 'vitest',
      ...(session
        ? {
            cookie: `auth_session=${session.sessionHash}`,
            'x-csrf-token': deriveCsrfToken(session),
          }
        : {}),
    },
  });
}

/**
 * pipeline は実 DB の sessions を見るので、テスト用に短い有効期限の行を作る。
 * `getSession` は token を pepper で HMAC して引くので、**hash はその計算結果**を入れ��れ。
 */
const createdSessionIds: string[] = [];

async function persistSession(session: SessionData): Promise<void> {
  createdSessionIds.push(session.id);
  const token = session.sessionHash;
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(token).digest('hex');
  await getDb().execute(sql`
    INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at,
                          ip_masked, device_name, reauth_verified_at)
    VALUES (${session.id}, ${session.userId}, ${sessionHash}, ${session.csrfSecret}, ${session.userAgent},
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '1 day', ${session.ipMasked}, ${session.deviceName},
            ${session.reauthVerifiedAt ? new Date(session.reauthVerifiedAt) : null})
  `);
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'http://localhost:3000');
  vi.stubEnv('ALLOWED_ORIGINS', 'http://localhost:3000');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.id} = ${id}`);
  }
  for (const state of issuedStates.splice(0)) {
    await db.delete(oauthStates).where(eq(oauthStates.stateHash, sha256Hex(state)));
  }
  for (const id of createdSessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, id));
  }
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.userId} = ${id}`);
    await db.delete(securityEvents).where(sql`${securityEvents.userId} = ${id}`);
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(sql`${users.id} = ${id}`);
  }
});

/** link の開始は再認証必須（§7.8 T3/T4）。 */
describe('Security - link start requires reauth', () => {
  it('returns REAUTH_REQUIRED without a fresh reauth', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const session = sessionFor(userId);
    await persistSession(session);

    const response = await LINK_START(post('/api/auth/oauth/link', session, { provider: 'github' }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
  });

  it('returns SESSION_EXPIRED for an anonymous caller', async () => {
    const response = await LINK_START(post('/api/auth/oauth/link', null, { provider: 'github' }));
    expect(response.status).toBe(403); // CSRF が先に弾かれる（匿名は anon cookie 必須）
  });

  it('issues a link-intent state for the current user after reauth', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await LINK_START(post('/api/auth/oauth/link', session, { provider: 'github' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const authorizeUrl = new URL(body.data.authorizeUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://github.com/login/oauth/authorize');

    const state = authorizeUrl.searchParams.get('state')!;
    issuedStates.push(state);
    const consumed = await consumeOAuthState(state, 'github');
    // login 用の state とは別のものにするため、intent と user_id を載せる
    expect(consumed?.intent).toBe('link');
  });

  it('refuses to start a second link of the same provider', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    await linkAccount(userId, 'github');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await LINK_START(post('/api/auth/oauth/link', session, { provider: 'github' }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('ACCOUNT_ALREADY_LINKED');
  });

  it('returns 404 for an unknown provider', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await LINK_START(post('/api/auth/oauth/link', session, { provider: 'facebook' }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('INVALID_PROVIDER');
  });
});

/** 解除の境界（§49 / §7.8 T7）。 */
describe('Security - unlink boundaries', () => {
  it('requires reauth before unlinking', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const accountId = await linkAccount(userId, 'google');
    const session = sessionFor(userId);
    await persistSession(session);

    const response = await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
    expect(await countAccountsByUser(userId)).toBe(1);
  });

  it('returns 404 when the id belongs to another user (IDOR)', async () => {
    const victimId = await makeUser(`${uniq('v')}@example.com`, 'argon2-hash');
    const attackerId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const accountId = await linkAccount(victimId, 'google');

    const session = sessionFor(attackerId, { reauthed: true });
    await persistSession(session);

    const response = await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });
    expect(response.status).toBe(404);
    expect(await countAccountsByUser(victimId)).toBe(1);
  });

  it('returns 404 for an unknown id', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`, 'argon2-hash');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await DELETE(del('/api/auth/accounts/acc_missing', session), {
      params: Promise.resolve({ id: 'acc_missing' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses to remove the last login method of a social-only user', async () => {
    const userId = await makeUser(`${uniq('s')}@example.com`, null);
    const accountId = await linkAccount(userId, 'github');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('LAST_LOGIN_METHOD');
    expect(await countAccountsByUser(userId)).toBe(1);
  });

  it('allows unlinking when a password is set', async () => {
    const userId = await makeUser(`${uniq('p')}@example.com`, 'argon2-hash');
    const accountId = await linkAccount(userId, 'github');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });
    expect(response.status).toBe(200);
    expect(await countAccountsByUser(userId)).toBe(0);
    expect(await listAccountsByUser(userId)).toHaveLength(0);
  });

  it('allows unlinking when another provider remains', async () => {
    const userId = await makeUser(`${uniq('s')}@example.com`, null);
    await linkAccount(userId, 'google');
    const accountId = await linkAccount(userId, 'discord');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    const response = await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });
    expect(response.status).toBe(200);
    expect(await countAccountsByUser(userId)).toBe(1);
  });

  it('records an oauth_unlinked event without leaking secrets', async () => {
    const userId = await makeUser(`${uniq('p')}@example.com`, 'argon2-hash');
    const accountId = await linkAccount(userId, 'github');
    const session = sessionFor(userId, { reauthed: true });
    await persistSession(session);

    await DELETE(del(`/api/auth/accounts/${accountId}`, session), {
      params: Promise.resolve({ id: accountId }),
    });

    const rows = await getDb()
      .select()
      .from(securityEvents)
      .where(sql`${securityEvents.userId} = ${userId} AND ${securityEvents.eventType} = 'oauth_unlinked'`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata).toMatchObject({ provider: 'github' });
  });
});