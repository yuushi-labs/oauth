import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, type Account, type NewAccount } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import type { SocialProvider } from '@/lib/db/schema';

/**
 * 外部 ID との紐付けのクエリ層（§10 / §11）。
 *
 * すべての検索・作成は provider を必ず条件に含める。`provider_account_id` は
 * provider ごとに独立した値なので、provider を省くと別 provider の同じ数値 ID を
 * 別のユーザーとして取り違える（D-31-10）。
 */

export async function findAccountByProviderAccountId(
  provider: SocialProvider,
  providerAccountId: string,
): Promise<Account | null> {
  const [row] = await getDb()
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)),
    )
    .limit(1);
  return row ?? null;
}

export async function listAccountsByUser(userId: string): Promise<Account[]> {
  return getDb()
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(accounts.createdAt);
}

/** owner 確認つきの取得。他人の id を渡しても null になる（IDOR 対策・§49）。 */
export async function findAccountByIdForUser(id: string, userId: string): Promise<Account | null> {
  const [row] = await getDb()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function hasProviderLinked(userId: string, provider: SocialProvider): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
    .limit(1);
  return Boolean(row);
}

export async function createAccount(data: Omit<NewAccount, 'id'>): Promise<Account> {
  const db = getDb();
  const [row] = await db
    .insert(accounts)
    .values({ ...data, id: newId('acc') })
    .returning();
  return row!;
}

export async function touchAccountLastUsed(id: string): Promise<void> {
  await getDb()
    .update(accounts)
    .set({ lastUsedAt: new Date() })
    .where(eq(accounts.id, id));
}

export async function deleteAccount(id: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning({ id: accounts.id });
  return rows.length === 1;
}

export async function countAccountsByUser(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return row?.count ?? 0;
}