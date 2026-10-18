import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  accounts,
  DEFAULT_ROLE_ID,
  oauthSocialClaims,
  securityEvents,
  users,
  type User,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { completeLogin, createSocialUser, findLiveUserByEmail } from '@/lib/auth/oauth/complete-login';
import {
  consumeSocialClaim,
  issueSocialClaim,
  peekSocialClaim,
} from '@/lib/auth/oauth/social-claim';
import {
  countAccountsByUser,
  createAccount,
  deleteAccount,
  findAccountByIdForUser,
  findAccountByProviderAccountId,
  hasProviderLinked,
  listAccountsByUser,
  touchAccountLastUsed,
} from '@/lib/auth/oauth/accounts';
import { isAcceptableUsername, toAsciiUsername, usernameCandidates } from '@/lib/auth/oauth/username';
import type { Identity } from '@/lib/auth/oauth/types';
import { sha256Hex } from '@/lib/util/crypto';

/**
 * login / link / 連携待ち（claim）の判定を実 DB で検証する（§11 / §7.8 / §4.3）。
 *
 * ここが Phase 4 / 4-B の心臓。email 一致での自動統合が**しない**ことと、
 * link で他人の外部 ID を**奪わない**ことを固定する。
 */

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const issuedTokens: string[] = [];

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

async function makeUser(email: string, passwordHash: string | null = null): Promise<string> {
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

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    providerAccountId: uniq('sub'),
    email: `${uniq('mail')}@example.com`,
    emailVerified: true,
    displayName: 'Test User',
    ...overrides,
  };
}

beforeAll(async () => {
  await getDb().delete(oauthSocialClaims);
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(eq(accounts.id, id));
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
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(eq(accounts.id, id));
  }
  for (const token of issuedTokens.splice(0)) {
    await db.delete(oauthSocialClaims).where(eq(oauthSocialClaims.stateHash, sha256Hex(token)));
  }
});

/** login: 紐付きがあればログイン、無ければ確認待ち（停止しない）。 */
describe('Integration - OAuth login decision', () => {
  it('logs in an already-linked user without creating anything', async () => {
    const userId = await makeUser(`${uniq('l')}@example.com`);
    const sub = uniq('sub');
    const account = await createAccount({
      userId,
      provider: 'google',
      providerAccountId: sub,
      providerEmail: null,
    });
    createdAccountIds.push(account.id);

    const outcome = await completeLogin({
      provider: 'google',
      identity: { providerAccountId: sub, email: null, emailVerified: false },
    });
    expect(outcome.kind).toBe('login');
    if (outcome.kind !== 'login') return;
    expect(outcome.user.id).toBe(userId);
    expect(outcome.accountId).toBe(account.id);
  });

  it('refuses to log in a suspended user', async () => {
    const id = identity();
    const created = await createSocialUser({ provider: 'google', identity: id });
    createdUserIds.push(created.user.id);
    createdAccountIds.push(created.accountId);

    await getDb().execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${created.user.id}`);

    const outcome = await completeLogin({ provider: 'google', identity: id });
    expect(outcome.kind).toBe('suspended');
  });

  it('does NOT stop with an error when the email belongs to an existing account', async () => {
    const email = `${uniq('m')}@example.com`;
    const ownerId = await makeUser(email);

    const outcome = await completeLogin({
      provider: 'github',
      identity: { providerAccountId: uniq('gh'), email, emailVerified: true },
    });

    // Phase 4-B: 停止ではなく確認待ち（D-32-01）
    expect(outcome.kind).toBe('needs_confirmation');
    if (outcome.kind !== 'needs_confirmation') return;
    expect(outcome.emailOwnerId).toBe(ownerId);
  });

  it('hands over an unowned email as a signup candidate', async () => {
    const outcome = await completeLogin({ provider: 'github', identity: identity() });
    expect(outcome.kind).toBe('needs_confirmation');
    if (outcome.kind !== 'needs_confirmation') return;
    expect(outcome.emailOwnerId).toBeNull();
  });

  it('ignores a soft-deleted account when resolving the email owner', async () => {
    const email = `${uniq('d')}@example.com`;
    const id = await makeUser(email);
    await getDb().execute(
      sql`UPDATE users SET status = 'deleted', deleted_at = NOW() WHERE id = ${id}`,
    );
    expect(await findLiveUserByEmail(email)).toBeNull();
  });
});

/** 新しい social-only ユーザー（確認画面で「作る」を選んだとき）。 */
describe('Integration - social user creation', () => {
  it('creates an active user with no password and a verified email', async () => {
    const { user, accountId } = await createSocialUser({ provider: 'google', identity: identity() });
    createdUserIds.push(user.id);
    createdAccountIds.push(accountId);

    const [row] = await getDb().select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(row!.passwordHash).toBeNull();
    expect(row!.emailVerified).toBe(true);
    expect(row!.status).toBe('active');
    expect(row!.username).toMatch(/^[A-Za-z0-9_-]{3,32}$/);
  });

  it('refuses to create a user from an unverified email', async () => {
    await expect(
      createSocialUser({
        provider: 'discord',
        identity: { providerAccountId: uniq('dc'), email: `${uniq('m')}@example.com`, emailVerified: false },
      }),
    ).rejects.toThrow();
  });

  it('never produces a placeholder-only username (BUG-14)', async () => {
    // 表示名「ミカさん」を ASCII 化すると `___` になる。英数字が無いので却下される。
    const { user } = await createSocialUser({
      provider: 'discord',
      identity: identity({ displayName: 'ミカさん' }),
    });
    createdUserIds.push(user.id);

    expect(user.username).not.toBe('___');
    expect(user.username).not.toMatch(/^[_-]+$/);
    // 表示名が使えなければ email のローカル部か user_ + ハッシュになる
    expect(isAcceptableUsername(user.username)).toBe(true);
  });
});

/** ★ link の脅威（§7.8）。 */
describe('Integration - OAuth link threats', () => {
  it('T1: refuses to take over an external id already linked to another user', async () => {
    const victimId = await makeUser(`${uniq('v')}@example.com`);
    const account = await createAccount({
      userId: victimId,
      provider: 'google',
      providerAccountId: uniq('sub'),
      providerEmail: null,
    });
    createdAccountIds.push(account.id);

    expect(await findAccountByProviderAccountId('google', account.providerAccountId)).not.toBeNull();
    expect(await countAccountsByUser(victimId)).toBe(1);
  });

  it('T2: never merges two accounts by email', async () => {
    const victimId = await makeUser(`${uniq('v')}@example.com`);
    // email が一致していても、`completeLogin` は統合せず emailOwnerId を返すだけ
    const outcome = await completeLogin({
      provider: 'google',
      identity: {
        providerAccountId: uniq('sub'),
        email: (await getDbUser(victimId)).email,
        emailVerified: true,
      },
    });
    expect(outcome.kind).toBe('needs_confirmation');
    if (outcome.kind !== 'needs_confirmation') return;
    expect(outcome.emailOwnerId).toBe(victimId);
    // accounts は増えていない（統合されていない）
    expect(await countAccountsByUser(victimId)).toBe(0);
  });

  it('keeps one account per provider', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`);
    const first = await createAccount({
      userId,
      provider: 'discord',
      providerAccountId: uniq('dc'),
      providerEmail: null,
    });
    createdAccountIds.push(first.id);

    expect(await hasProviderLinked(userId, 'discord')).toBe(true);
    expect(await hasProviderLinked(userId, 'google')).toBe(false);
  });
});

/** 解除と「最後の認証手段」判定。 */
describe('Integration - OAuth unlink', () => {
  it('deletes only the owner row and reports not-found for another user', async () => {
    const ownerId = await makeUser(`${uniq('o')}@example.com`);
    const otherId = await makeUser(`${uniq('x')}@example.com`);
    const account = await createAccount({
      userId: ownerId,
      provider: 'google',
      providerAccountId: uniq('sub'),
      providerEmail: null,
    });

    expect(await findAccountByIdForUser(account.id, otherId)).toBeNull();
    expect(await deleteAccount(account.id, otherId)).toBe(false);
    expect(await countAccountsByUser(ownerId)).toBe(1);

    expect(await deleteAccount(account.id, ownerId)).toBe(true);
    expect(await countAccountsByUser(ownerId)).toBe(0);
  });

  it('updates last_used_at on touch', async () => {
    const userId = await makeUser(`${uniq('t')}@example.com`);
    const account = await createAccount({
      userId,
      provider: 'github',
      providerAccountId: uniq('gh'),
      providerEmail: null,
    });
    createdAccountIds.push(account.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await touchAccountLastUsed(account.id);
    const [row] = await getDb().select().from(accounts).where(eq(accounts.id, account.id));
    expect(row!.lastUsedAt.getTime()).toBeGreaterThan(row!.createdAt.getTime());
  });

  it('lists only the owner rows', async () => {
    const ownerId = await makeUser(`${uniq('o')}@example.com`);
    const otherId = await makeUser(`${uniq('x')}@example.com`);
    const mine = await createAccount({
      userId: ownerId,
      provider: 'google',
      providerAccountId: uniq('sub'),
      providerEmail: null,
    });
    createdAccountIds.push(mine.id);
    await createAccount({
      userId: otherId,
      provider: 'google',
      providerAccountId: uniq('sub'),
      providerEmail: null,
    });

    const rows = await listAccountsByUser(ownerId);
    expect(rows.map((row) => row.id)).toEqual([mine.id]);
  });
});

/** §10: UNIQUE は provider をまたいでも独立。 */
describe('Integration - accounts uniqueness', () => {
  it('keeps the same external id usable under a different provider', async () => {
    const userId = await makeUser(`${uniq('u')}@example.com`);
    const shared = uniq('numeric');

    const googleAccount = await createAccount({
      userId,
      provider: 'google',
      providerAccountId: shared,
      providerEmail: null,
    });
    createdAccountIds.push(googleAccount.id);
    const githubAccount = await createAccount({
      userId,
      provider: 'github',
      providerAccountId: shared,
      providerEmail: null,
    });
    createdAccountIds.push(githubAccount.id);

    expect(googleAccount.id).not.toBe(githubAccount.id);
    expect(await countAccountsByUser(userId)).toBe(2);
  });

  it('rejects a duplicate (provider, provider_account_id)', async () => {
    const userId = await makeUser(`${uniq('u')}@example.com`);
    const shared = uniq('numeric');
    const first = await createAccount({
      userId,
      provider: 'github',
      providerAccountId: shared,
      providerEmail: null,
    });
    createdAccountIds.push(first.id);

    await expect(
      createAccount({
        userId,
        provider: 'github',
        providerAccountId: shared,
        providerEmail: null,
      }),
    ).rejects.toThrow();
  });
});

/** 連携確認待ち（claim・Phase 4-B）。 */
describe('Integration - social claim', () => {
  it('stores only the hash of the token', async () => {
    const { token } = await issueSocialClaim({ provider: 'google', identity: identity(), emailOwnerId: null });
    issuedTokens.push(token);

    const [row] = await getDb().select().from(oauthSocialClaims);
    expect(row!.stateHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('consumes exactly once', async () => {
    const { token } = await issueSocialClaim({ provider: 'github', identity: identity(), emailOwnerId: null });
    issuedTokens.push(token);

    expect(await consumeSocialClaim(token, 'github')).not.toBeNull();
    expect(await consumeSocialClaim(token, 'github')).toBeNull();
  });

  it('cannot be consumed by another provider', async () => {
    const { token } = await issueSocialClaim({ provider: 'google', identity: identity(), emailOwnerId: null });
    issuedTokens.push(token);

    expect(await consumeSocialClaim(token, 'github')).toBeNull();
    expect(await consumeSocialClaim(token, 'google')).not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await consumeSocialClaim('never-issued', 'google')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await issueSocialClaim({ provider: 'discord', identity: identity(), emailOwnerId: null });
    issuedTokens.push(token);

    await getDb()
      .update(oauthSocialClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthSocialClaims.stateHash, sha256Hex(token)));

    expect(await consumeSocialClaim(token, 'discord')).toBeNull();
  });

  it('peek does not consume', async () => {
    const { token } = await issueSocialClaim({ provider: 'google', identity: identity(), emailOwnerId: null });
    issuedTokens.push(token);

    const first = await peekSocialClaim(token, 'google');
    const second = await peekSocialClaim(token, 'google');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await consumeSocialClaim(token, 'google')).not.toBeNull();
  });

  it('binds the email owner at issue time', async () => {
    const email = `${uniq('o')}@example.com`;
    const ownerId = await makeUser(email);
    const { token } = await issueSocialClaim({
      provider: 'google',
      identity: { providerAccountId: uniq('sub'), email, emailVerified: true },
      emailOwnerId: ownerId,
    });
    issuedTokens.push(token);

    const claim = await consumeSocialClaim(token, 'google');
    expect(claim!.emailOwnerId).toBe(ownerId);
    expect(claim!.providerEmail).toBe(email);
    expect(claim!.emailVerified).toBe(true);
  });

  it('carries emailVerified = false through without a usable email', async () => {
    const { token } = await issueSocialClaim({
      provider: 'discord',
      identity: { providerAccountId: uniq('dc'), email: null, emailVerified: false },
      emailOwnerId: null,
    });
    issuedTokens.push(token);

    const claim = await consumeSocialClaim(token, 'discord');
    expect(claim!.emailVerified).toBe(false);
    expect(claim!.providerEmail).toBeNull();
  });
});

/** username 生成（§4.5 / D-32-11 / BUG-14）。 */
describe('username generation', () => {
  it('rejects placeholder-only and separator-only names', () => {
    expect(isAcceptableUsername('___')).toBe(false);
    expect(isAcceptableUsername('---')).toBe(false);
    expect(isAcceptableUsername('_abc')).toBe(false);
    expect(isAcceptableUsername('ab')).toBe(false);
    expect(isAcceptableUsername('a'.repeat(33))).toBe(false);
    expect(isAcceptableUsername('octo')).toBe(true);
    expect(isAcceptableUsername('user_1a2b3c')).toBe(true);
  });

  it('strips non-ASCII and collapses separators', () => {
    expect(toAsciiUsername('ミカさん')).toBe('');
    expect(toAsciiUsername('octo cat')).toBe('octocat');
    expect(toAsciiUsername('__octo__')).toBe('octo');
  });

  it('prefers the display name, then the email local part', () => {
    // 表示名が先、その次に email のローカル部。両方が tried される
    expect(
      usernameCandidates(identity({ displayName: 'octo', email: 'octocat@example.com' })),
    ).toEqual(['octo', 'octocat']);
    // 表示名は ASCII 化できないので email のローカル部（`.` は除去される）が使われる
    expect(usernameCandidates(identity({ displayName: 'ミカさん', email: 'mika.san@example.com' }))).toEqual([
      'mikasan',
    ]);
    // どちらも ASCII 名にならないときは空配列（呼び出し側がフォールバックする）
    expect(usernameCandidates(identity({ displayName: 'ミカさん', email: 'ミカ@example.com' }))).toEqual([]);
  });
});

async function getDbUser(id: string): Promise<User> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user not found: ${id}`);
  return row;
}