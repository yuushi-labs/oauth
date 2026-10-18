import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, users, type User } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { newId } from '@/lib/util/id';
import { allocateUsername } from './username';
import { createAccount, findAccountByProviderAccountId, touchAccountLastUsed } from './accounts';
import type { Identity } from './types';
import type { SocialProvider } from '@/lib/db/schema';

/**
 * login intent の判定（§11 / §12.2 / Phase 4-B）。
 *
 * **email 一致での自動統合はしない**（§11）。Phase 4-B 以降、紐付きが無い場合は
 * 停止せず「確認待ち」として呼び出し側へ返す（`needs_confirmation`）。
 * 新規登録も、既存アカウントへの連携も、**利用者本人の確定操作**を挟んでから行う。
 */

export type LoginOutcome =
  | { kind: 'login'; user: User; accountId: string }
  /** 紐付きが無い。確認画面へ遷移する（D-32-01） */
  | { kind: 'needs_confirmation'; identity: Identity; emailOwnerId: string | null }
  | { kind: 'suspended' };

export async function completeLogin(args: {
  provider: SocialProvider;
  identity: Identity;
}): Promise<LoginOutcome> {
  const { provider, identity } = args;

  const existing = await findAccountByProviderAccountId(provider, identity.providerAccountId);
  if (existing) {
    const user = await findUserById(existing.userId);
    if (!user) return { kind: 'suspended' };
    // suspended / deleted / pending_email はすべてログインさせない。
    // 論理削除済みユーザーの external ID を別人が使い継ぐことも許さない（D-31-09）。
    if (user.status !== 'active') return { kind: 'suspended' };

    await touchAccountLastUsed(existing.id);
    return { kind: 'login', user, accountId: existing.id };
  }

  // 紐付きが無い。email の所有者を確定して確認待ちとして返す。
  // 「email が一致するから停产する」ことはしない。連携には password 証明が要る（D-32-03）。
  const emailOwner = identity.email ? await findLiveUserByEmail(identity.email) : null;

  return {
    kind: 'needs_confirmation',
    identity,
    emailOwnerId: emailOwner?.id ?? null,
  };
}

/** 新規 social-only ユーザーと accounts 行を作る（確認画面で「作る」を選んだとき）。 */
export async function createSocialUser(args: {
  provider: SocialProvider;
  identity: Identity;
}): Promise<{ user: User; accountId: string }> {
  const { provider, identity } = args;
  if (!identity.emailVerified || !identity.email) {
    throw new Error('検証済み email のない social ユーザーは作成できません');
  }

  const user = await createUser({
    id: newId('usr'),
    username: await allocateUsername(identity),
    email: identity.email,
    emailVerified: true,
    passwordHash: null,
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });

  const account = await createAccount({
    userId: user.id,
    provider,
    providerAccountId: identity.providerAccountId,
    providerEmail: identity.email,
  });

  return { user, accountId: account.id };
}

async function findUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** 論理削除済みは email 再利用の衝突対象から外す（users の partial unique index と同じ考え方・D-04）。 */
export async function findLiveUserByEmail(email: string): Promise<User | null> {
  const [row] = await getDb()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) return null;
  return row.status === 'deleted' || row.deletedAt ? null : row;
}