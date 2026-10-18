import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users, type User } from '@/lib/db/schema';
import {
  createAccount,
  findAccountByProviderAccountId,
  hasProviderLinked,
} from './accounts';
import type { Identity } from './types';
import type { SocialProvider } from '@/lib/db/schema';

/**
 * link intent の判定（§11 / §12.2）。
 *
 * link は「認証済みのユーザーが、自分のアカウントに外部 ID を紐付ける」操作であり、
 * **新規登録より攻撃面が広い**。email の同一性を使わないため、判定は次の 4 条件だけに
 * 基づく（いずれも拒否-first）:
 *
 * | # | 条件 | 結果 |
 * |---|---|---|
 * | 1 | `(provider, provider_account_id)` が既に存在する（誰のものか問わない） | `linked_elsewhere` として拒否 |
 * | 2 | 同じ provider を既に紐付けている | `already_linked` として拒否 |
 * | 3 | email が別ユーザーに登録済み | `email_conflict` として拒否（自動 link しない） |
 * | 4 | 検証済み email が取れない | `not_linkable` として拒否 |
 *
 * **条件 1 が最重要**。ここを「他人のものなら上書きする」にすると、
 * 攻撃者が自分のアカウントに他人の Google を紐付けて乗っ取れる。
 */
export type LinkOutcome =
  | { kind: 'linked'; accountId: string }
  | { kind: 'already_linked' }
  | { kind: 'linked_elsewhere' }
  | { kind: 'email_conflict' }
  | { kind: 'not_linkable' };

export async function completeLink(args: {
  user: User;
  provider: SocialProvider;
  identity: Identity;
}): Promise<LinkOutcome> {
  const { user, provider, identity } = args;

  // 1. 既存の外部 ID を奪わない（最重要・§7.8 T1）
  const taken = await findAccountByProviderAccountId(provider, identity.providerAccountId);
  if (taken) return { kind: 'linked_elsewhere' };

  // 2. 1 ユーザー 1 provider 1 件
  if (await hasProviderLinked(user.id, provider)) return { kind: 'already_linked' };

  // 3. 未検証 email・email 不明は紐付けない（T6）
  if (!identity.emailVerified || !identity.email) return { kind: 'not_linkable' };

  // 4. email 一致する別ユーザーがいても自動 link しない（T2 / §11）
  if (await findLiveUserByEmail(identity.email, user.id)) return { kind: 'email_conflict' };

  const account = await createAccount({
    userId: user.id,
    provider,
    providerAccountId: identity.providerAccountId,
    providerEmail: identity.email,
  });
  return { kind: 'linked', accountId: account.id };
}

async function findLiveUserByEmail(email: string, excludeUserId: string): Promise<User | null> {
  const [row] = await getDb()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) return null;
  if (row.id === excludeUserId) return null;
  return row.status === 'deleted' || row.deletedAt ? null : row;
}