import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  accounts,
  DEFAULT_ROLE_ID,
  oauthSocialClaims,
  securityEvents,
  sessions,
  users,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { issueSocialClaim } from '@/lib/auth/oauth/social-claim';
import { countAccountsByUser, findAccountByProviderAccountId } from '@/lib/auth/oauth/accounts';
import { sha256Hex } from '@/lib/util/crypto';
import { POST as COMPLETE } from '@/app/api/auth/oauth/social-login/route';
import type { SessionData } from '@/lib/auth/session';

/**
 * ★ Phase 4-B の乗っ取り回帰（§4.3 / D-32-03 / D-32-04）。
 *
 * 連携の証明は「**social の email を持つアカウントのパスワード**」だけ。
 * email 一致のみでは絶対に `accounts` 行を作らない。
 */

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: async () => ({ allowed: true, logRateLimited: false, resetAt: Date.now() + 60_000 }),
    reserveFailedAttempt: async () => ({
      allowed: true,
      reservation: { reservationId: 'r', key: 'k', generation: 1, captchaRequired: false, resetAt: Date.now() + 60_000 },
    }),
    releaseReservation: async () => undefined,
    finishFailedAttempt: async () => false,
  },
}));

vi.mock('@/lib/auth/notifications', () => ({
  isFirstSessionFromDevice: async () => false,
  notifyNewDeviceLogin: async () => true,
  notifyAccountChange: async () => true,
}));

// セッション Cookie の書き込みは Next の request scope（`cookies()`）に依存するため、
// ルートを直接呼ぶテストでは無効化する。Cookie 名と属性の検証は e2e 側で行う。
const issuedSessionTokens: string[] = [];

vi.mock('@/lib/auth/cookie', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/cookie')>();
  return {
    ...actual,
    setSessionCookie: async (token: string) => {
      issuedSessionTokens.push(token);
    },
    setAnonCookie: async () => undefined,
  };
});

const PASSWORD = 'Phase4B-Strong-Pass-2026!';

const ENV = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-id',
  GITHUB_CLIENT_SECRET: 'github-secret',
  DISCORD_CLIENT_ID: 'discord-id',
  DISCORD_CLIENT_SECRET: 'discord-secret',
};

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
const issuedTokens: string[] = [];

let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(email: string, password: string | null): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email,
    emailVerified: true,
    passwordHash: password === null ? null : await hashPassword(password),
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

function sessionFor(userId: string): SessionData {
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
    reauthVerifiedAt: new Date().toISOString(),
    totpPending: false,
  };
}

async function persistSession(session: SessionData): Promise<void> {
  createdSessionIds.push(session.id);
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(session.sessionHash).digest('hex');
  await getDb().execute(sql`
    INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at,
                          ip_masked, device_name)
    VALUES (${session.id}, ${session.userId}, ${sessionHash}, ${session.csrfSecret}, ${session.userAgent},
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '1 day', ${session.ipMasked}, ${session.deviceName})
  `);
}

/**
 * 完了リクエスト。claim token は **Cookie** で渡す（URL には載せない）。
 *
 * 未ログインの POST には anon cookie と、从中導いた CSRF トークンが要る。
 * ログインユited場合は session cookie と `deriveCsrfToken` を使う。
 */
function complete(body: unknown, claimToken: string, session: SessionData | null): NextRequest {
  const cookies = [`auth_social_claim=${claimToken}`, `auth_anon=${anonCookiePair()}`];
  let csrfToken = ANON_SECRET;
  if (session) {
    cookies.push(`auth_session=${session.sessionHash}`);
    csrfToken = deriveCsrfToken(session);
  }

  return new NextRequest('http://localhost:3000/api/auth/oauth/social-login', {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: cookies.join('; '),
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

/** 匿名 CSRF 用の固定 secret（`getAnonCsrfSecret` が検証する形式）。 */
const ANON_SECRET = 'anon-csrf-secret-for-tests';

function anonCookiePair(): string {
  const signature = createHmac('sha256', process.env.CSRF_SECRET!).update(ANON_SECRET).digest('hex');
  return `${ANON_SECRET}.${signature}`;
}

beforeAll(async () => {
  await getDb().delete(oauthSocialClaims);
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdSessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(eq(accounts.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(oauthSocialClaims).where(eq(oauthSocialClaims.emailOwnerId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

afterEach(async () => {
  const db = getDb();
  issuedSessionTokens.length = 0;
  for (const token of issuedTokens.splice(0)) {
    await db.delete(oauthSocialClaims).where(eq(oauthSocialClaims.stateHash, sha256Hex(token)));
  }
});

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'http://localhost:3000');
  vi.stubEnv('ALLOWED_ORIGINS', 'http://localhost:3000');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function issueFor(args: {
  email: string | null;
  emailVerified: boolean;
  emailOwnerId: string | null;
  provider?: 'google' | 'github' | 'discord';
}): Promise<string> {
  const { token } = await issueSocialClaim({
    provider: args.provider ?? 'google',
    identity: { providerAccountId: uniq('sub'), email: args.email, emailVerified: args.emailVerified },
    emailOwnerId: args.emailOwnerId,
  });
  issuedTokens.push(token);
  return token;
}

/** ★ 中核: email 所有者の password なら連携できる。 */
describe('Security - social confirm links with the email owner password', () => {
  it('links the account and issues a session when the owner password is correct', async () => {
    const email = `${uniq('o')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });

    const response = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );

    expect(response.status).toBe(303);
    expect(issuedSessionTokens.length).toBe(1);

    const linked = await findAccountByProviderAccountId('google', (await claimOf(token))!.providerAccountId);
    expect(linked).not.toBeNull();
    expect(linked!.userId).toBe(ownerId);
  });

  /**
   * ★ D-32-18 の回帰。
   * 同じ password を使う別ユーザーがいるとき、email 入力を差し替えるだけで
   * そのアカウントに入れてしまうため、**別アカウントではログインもさせない**。
   */
  it('does NOT log in nor link when the email is swapped for another account', async () => {
    const socialEmail = `${uniq('v')}@example.com`;
    const otherEmail = `${uniq('a')}@example.com`;
    const ownerId = await makeUser(socialEmail, PASSWORD);
    await makeUser(otherEmail, PASSWORD);

    const token = await issueFor({ email: socialEmail, emailVerified: true, emailOwnerId: ownerId });

    const response = await COMPLETE(
      complete({ action: 'password', identifier: otherEmail, password: PASSWORD }, token, null),
    );

    // どちらのアカウントにも入れない（列挙対策のため reason も返さない）
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
    expect(issuedSessionTokens.length).toBe(0);
    expect(await countAccountsByUser(ownerId)).toBe(0);
    const rows = await getDb().select().from(accounts);
    expect(rows.filter((row) => row.providerEmail === socialEmail)).toHaveLength(0);
  });

  it('does NOT log in when the shared password matches but the username is used instead of the email', async () => {
    const socialEmail = `${uniq('v')}@example.com`;
    const otherUsername = `other_${uniq('u')}`;
    const ownerId = await makeUser(socialEmail, PASSWORD);
    await createUser({
      id: `usr_${uniq('t')}`,
      username: otherUsername,
      email: `${uniq('o')}@example.com`,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      status: 'active',
      roleId: DEFAULT_ROLE_ID,
    }).then((user) => createdUserIds.push(user.id));

    const token = await issueFor({ email: socialEmail, emailVerified: true, emailOwnerId: ownerId });

    const response = await COMPLETE(
      complete({ action: 'password', identifier: otherUsername, password: PASSWORD }, token, null),
    );

    expect(response.status).toBe(401);
    expect(issuedSessionTokens.length).toBe(0);
    expect(await countAccountsByUser(ownerId)).toBe(0);
  });

  it('refuses a password login when the email has no local account at all', async () => {
    const email = `${uniq('free')}@example.com`;
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: null });

    const response = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );

    // 連携の相手がいないので、この画面では password ログインできない
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('ACCOUNT_LINK_OWNER_MISMATCH');
    expect(issuedSessionTokens.length).toBe(0);
  });

  it('does not link when the password is wrong', async () => {
    const email = `${uniq('v')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });

    const response = await COMPLETE(
      complete({ action: 'password', identifier: email, password: 'wrong-password' }, token, null),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    // 列挙攻撃対策：どの email のアカウントだったかは教えない
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await countAccountsByUser(ownerId)).toBe(0);
    expect(issuedSessionTokens.length).toBe(0);
  });

  it('does not link a suspended account', async () => {
    const email = `${uniq('s')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    await getDb().execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${ownerId}`);

    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });
    const response = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );

    expect(response.status).toBe(403);
    expect(await countAccountsByUser(ownerId)).toBe(0);
  });

  it('refuses to reuse a consumed claim', async () => {
    const email = `${uniq('r')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });

    const first = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );
    expect(first.status).toBe(303);

    const second = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe('INVALID_STATE');
  });

  it('rejects a missing claim cookie', async () => {
    const response = await COMPLETE(
      complete({ action: 'password', identifier: 'a@b.example', password: PASSWORD }, '', null),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_STATE');
  });
});

/** 新規登録側。 */
describe('Security - social confirm signup', () => {
  it('creates a social-only user when the email is unowned and verified', async () => {
    const email = `${uniq('n')}@example.com`;
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: null });

    const response = await COMPLETE(
      complete({ action: 'signup' }, token, null),
    );

    expect(response.status).toBe(303);
    expect(issuedSessionTokens.length).toBe(1);

    const [row] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
    expect(row!.passwordHash).toBeNull();
    expect(row!.emailVerified).toBe(true);
    expect(row!.username).toMatch(/^[A-Za-z0-9_-]{3,32}$/);
    expect(isReadable(row!.username)).toBe(true);
  });

  it('refuses signup when the email is unverified', async () => {
    const email = `${uniq('u')}@example.com`;
    const token = await issueFor({ email, emailVerified: false, emailOwnerId: null });

    const response = await COMPLETE(
      complete({ action: 'signup' }, token, null),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('ACCOUNT_NOT_LINKABLE');
  });

  it('refuses signup when the email already belongs to an account', async () => {
    const email = `${uniq('c')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });

    const response = await COMPLETE(
      complete({ action: 'signup' }, token, null),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('EMAIL_CONFLICT');
    expect(await countAccountsByUser(ownerId)).toBe(0);
  });

  it('refuses signup when the provider returned no email', async () => {
    const token = await issueFor({ email: null, emailVerified: false, emailOwnerId: null });
    const response = await COMPLETE(
      complete({ action: 'signup' }, token, null),
    );
    expect(response.status).toBe(400);
  });
});

/** TOCTOU: callback と完了の間に他人が同じ外部 ID を紐付けた。 */
describe('Security - social confirm TOCTOU', () => {
  it('refuses when the external id got linked by someone else in the meantime', async () => {
    const email = `${uniq('t')}@example.com`;
    const ownerId = await makeUser(email, PASSWORD);
    const token = await issueFor({ email, emailVerified: true, emailOwnerId: ownerId });

    // 途中で別のユーザーが同じ (provider, provider_account_id) を紐付けたとする
    const claim = await claimOf(token);
    await getDb().execute(sql`
      INSERT INTO accounts (id, user_id, provider, provider_account_id, provider_email)
      VALUES (${`acc_${uniq('x')}`}, ${ownerId}, 'google', ${claim!.providerAccountId}, NULL)
    `);

    const response = await COMPLETE(
      complete({ action: 'password', identifier: email, password: PASSWORD }, token, null),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('ACCOUNT_LINKED_ELSEWHERE');
  });
});

function isReadable(username: string): boolean {
  return /[A-Za-z0-9]/.test(username) && !/^[_-]/.test(username);
}

async function claimOf(token: string) {
  const [row] = await getDb()
    .select()
    .from(oauthSocialClaims)
    .where(eq(oauthSocialClaims.stateHash, sha256Hex(token)));
  return row ?? null;
}