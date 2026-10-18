import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, users, DEFAULT_ROLE_ID, oauthStates, securityEvents, type User } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { completeLogin } from '@/lib/auth/oauth/complete-login';
import { completeLink } from '@/lib/auth/oauth/complete-link';
import {
  countAccountsByUser,
  createAccount,
  deleteAccount,
  findAccountByIdForUser,
  listAccountsByUser,
  touchAccountLastUsed,
} from '@/lib/auth/oauth/accounts';
import type { Identity } from '@/lib/auth/oauth/types';

/**
 * login / link の判定ロジックを実 DB で検証する（§11 / §7.8）。
 *
 * ここが Phase 4 の心臓。email 一致での自動統合を**しない**ことと、
 * link で他人の外部 ID を**奪わない**ことを固定する。
 */

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

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
    email: uniq('mail') + '@example.com',
    emailVerified: true,
    displayName: 'Test User',
    ...overrides,
  };
}

beforeAll(async () => {
  await getDb().delete(oauthStates);
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.id} = ${id}`);
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.userId} = ${id}`);
    await db.delete(securityEvents).where(sql`${securityEvents.userId} = ${id}`);
    await db.delete(users).where(eq(users.id, id));
  }
});

afterEach(async () => {
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.id} = ${id}`);
  }
});

/** login: 3 分岐（既存リンク / email 一致で停止 / 新規作成）。 */
describe('Integration - OAuth login decision', () => {
  it('registers a social-only user with no password and a verified email', async () => {
    const id = identity();
    const outcome = await completeLogin({ provider: 'google', identity: id });

    expect(outcome.kind).toBe('register');
    if (outcome.kind !== 'register') return;
    createdAccountIds.push(outcome.accountId);

    const [row] = await getDb().select().from(users).where(eq(users.id, outcome.user.id)).limit(1);
    expect(row!.passwordHash).toBeNull();
    expect(row!.emailVerified).toBe(true);
    expect(row!.status).toBe('active');
    // パスワード無しでも active にするには email_verified が必須（CHECK 制約）
    expect(outcome.user.username).toMatch(/^[A-Za-z0-9_-]{3,32}$/);
  });

  it('logs in the same user on a second visit without creating another user', async () => {
    const first = await completeLogin({ provider: 'google', identity: identity() });
    expect(first.kind).toBe('register');
    if (first.kind !== 'register') return;
    createdAccountIds.push(first.accountId);

    const second = await completeLogin({
      provider: 'google',
      identity: {
        providerAccountId: (await findProviderAccountId(first.accountId))!,
        email: 'changed@example.com',
        emailVerified: true,
      },
    });
    expect(second.kind).toBe('login');
    if (second.kind !== 'login') return;
    // email が provider 側で変わっても、紐付けが.User を変えない
    expect(second.user.id).toBe(first.user.id);
  });

  it('stops with link_required instead of merging by email', async () => {
    const email = `${uniq('m')}@example.com`;
    await makeUser(email);

    const outcome = await completeLogin({
      provider: 'github',
      identity: { providerAccountId: uniq('gh'), email, emailVerified: true },
    });
    expect(outcome.kind).toBe('link_required');
  });

  it('does not register when the email is unverified', async () => {
    const outcome = await completeLogin({
      provider: 'discord',
      identity: { providerAccountId: uniq('dc'), email: `${uniq('m')}@example.com`, emailVerified: false },
    });
    expect(outcome.kind).toBe('not_linkable');
  });

  it('does not register when the provider returns no email', async () => {
    const outcome = await completeLogin({
      provider: 'discord',
      identity: { providerAccountId: uniq('dc'), email: null, emailVerified: true },
    });
    expect(outcome.kind).toBe('not_linkable');
  });

  it('refuses to log in a suspended user', async () => {
    const id = identity();
    const registered = await completeLogin({ provider: 'google', identity: id });
    expect(registered.kind).toBe('register');
    if (registered.kind !== 'register') return;
    createdAccountIds.push(registered.accountId);

    await getDb().execute(
      sql`UPDATE users SET status = 'suspended' WHERE id = ${registered.user.id}`,
    );

    const outcome = await completeLogin({ provider: 'google', identity: id });
    expect(outcome.kind).toBe('suspended');
  });
});

/** ★ link の脅威（§7.8）。 */
describe('Integration - OAuth link threats', () => {
  it('T1: refuses to take over an external id already linked to another user', async () => {
    const victimId = await makeUser(`${uniq('v')}@example.com`);
    const attackerId = await makeUser(`${uniq('a')}@example.com`);
    const shared = uniq('sub');

    const victimAccount = await createAccount({
      userId: victimId,
      provider: 'google',
      providerAccountId: shared,
      providerEmail: null,
    });
    createdAccountIds.push(victimAccount.id);

    const attacker = await getDbUser(attackerId);
    const outcome = await completeLink({
      user: attacker,
      provider: 'google',
      identity: { providerAccountId: shared, email: null, emailVerified: false },
    });

    expect(outcome.kind).toBe('linked_elsewhere');
    // 既存の行は書き換えられない
    const [row] = await getDb()
      .select()
      .from(accounts)
      .where(sql`${accounts.id} = ${victimAccount.id}`);
    expect(row!.userId).toBe(victimId);
    expect(await countAccountsByUser(attackerId)).toBe(0);
  });

  it('T2: refuses to link by email even when the email matches another account', async () => {
    const victimId = await makeUser(`${uniq('v')}@example.com`);
    const attackerId = await makeUser(`${uniq('a')}@example.com`);
    const victimEmail = `${uniq('v')}@example.com`;
    await getDb().execute(sql`UPDATE users SET email = ${victimEmail} WHERE id = ${victimId}`);

    const attacker = await getDbUser(attackerId);
    const outcome = await completeLink({
      user: attacker,
      provider: 'github',
      identity: { providerAccountId: uniq('gh'), email: victimEmail, emailVerified: true },
    });

    expect(outcome.kind).toBe('email_conflict');
    expect(await countAccountsByUser(attackerId)).toBe(0);
  });

  it('rejects a second link of the same provider', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`);
    const first = await createAccount({
      userId,
      provider: 'discord',
      providerAccountId: uniq('dc'),
      providerEmail: null,
    });
    createdAccountIds.push(first.id);

    const outcome = await completeLink({
      user: await getDbUser(userId),
      provider: 'discord',
      identity: { providerAccountId: uniq('dc'), email: `${uniq('m')}@example.com`, emailVerified: true },
    });
    expect(outcome.kind).toBe('already_linked');
  });

  it('rejects a link with an unverified or missing email', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`);
    const user = await getDbUser(userId);

    expect(
      (await completeLink({
        user,
        provider: 'github',
        identity: { providerAccountId: uniq('gh'), email: null, emailVerified: false },
      })).kind,
    ).toBe('not_linkable');
  });

  it('T5: link and login states are not interchangeable (intent is stored per state)', async () => {
    const userId = await makeUser(`${uniq('a')}@example.com`);
    const linked = await createAccount({
      userId,
      provider: 'google',
      providerAccountId: uniq('sub'),
      providerEmail: null,
    });
    createdAccountIds.push(linked.id);

    // login intent で同じ外部 ID を使う = そのユーザーとしてログイン（link ではない）
    const login = await completeLogin({
      provider: 'google',
      identity: { providerAccountId: linked.providerAccountId, email: null, emailVerified: false },
    });
    expect(login.kind).toBe('login');
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

  it('knows when the last login method would be removed', async () => {
    const socialOnly = await makeUser(`${uniq('s')}@example.com`, null);
    const withPassword = await makeUser(`${uniq('p')}@example.com`, 'argon2-hash');

    expect(await countAccountsByUser(socialOnly)).toBe(0);
    expect(await countAccountsByUser(withPassword)).toBe(0);
    // passwordHash === null かつ accounts 0 件 = 最後の認証手段を失う状態
    const user = await getDbUser(socialOnly);
    expect(user.passwordHash).toBeNull();
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
    const [row] = await getDb().select().from(accounts).where(sql`${accounts.id} = ${account.id}`);
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

async function findProviderAccountId(accountId: string): Promise<string | null> {
  const [row] = await getDb().select().from(accounts).where(sql`${accounts.id} = ${accountId}`);
  return row?.providerAccountId ?? null;
}

async function getDbUser(id: string): Promise<User> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user not found: ${id}`);
  return row;
}