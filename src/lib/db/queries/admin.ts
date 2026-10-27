import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { ROLE_IDS, totp, users, webauthnCredentials } from '@/lib/db/schema';

/**
 * 管理者向けのユーザー一覧（§51・§11.6）。
 *
 * **secret 列（`password_hash` / TOTP secret / passkey 公開鍵・`credential_id`）は選択しない**。
 * 表示に必要な情報と、boolean / 数値に畳んだ `has_password` / `has_2fa` / `passkey_count` だけを返す。
 */
export type AdminUserRow = {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  status: string;
  roleId: string;
  createdAt: Date;
  deletedAt: Date | null;
  hasPassword: boolean;
  has2fa: boolean;
  passkeyCount: number;
};

export async function listAdminUsers(options: {
  limit: number;
  offset: number;
}): Promise<{ users: AdminUserRow[]; total: number }> {
  const db = getDb();

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
      status: users.status,
      roleId: users.roleId,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
      hasPassword: sql<boolean>`(${users.passwordHash} is not null)`,
      has2fa: sql<boolean>`coalesce(bool_or(${totp.enabled}), false)`,
      passkeyCount: sql<number>`count(distinct ${webauthnCredentials.id})::int`,
    })
    .from(users)
    .leftJoin(webauthnCredentials, eq(webauthnCredentials.userId, users.id))
    .leftJoin(totp, eq(totp.userId, users.id))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt))
    .limit(options.limit)
    .offset(options.offset);

  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(users);

  return { users: rows, total: countRow?.total ?? 0 };
}

/** 監査対象のユーザー。論理削除済みは返さない（§49・D-35-11）。 */
export async function findAdminTarget(id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function suspendUser(id: string): Promise<void> {
  const db = getDb();
  await db.update(users).set({ status: 'suspended', updatedAt: new Date() }).where(eq(users.id, id));
}

/** 停止の解除。`email_verified` なら `active`、未確認なら `pending_email` に戻す（CHECK 制約に整合）。 */
export async function unsuspendUser(id: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const status = row?.emailVerified ? 'active' : 'pending_email';
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
  return status;
}

/** role を変更する（Phase 7.5）。セッションは失効させない（D-36-04）。 */
export async function setUserRole(id: string, roleId: string): Promise<void> {
  const db = getDb();
  await db.update(users).set({ roleId, updatedAt: new Date() }).where(eq(users.id, id));
}

/**
 * `excludeUserId` を除いた「有効な管理者」の人数（D-36-03）。
 *
 * 有効 = `deleted_at IS NULL` かつ `status = 'active'` かつ rank ≥ admin。
 * これが 0 のとき、対象を降格すると管理者が 0 人になる。
 */
export async function countOtherUsableAdmins(excludeUserId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        ne(users.id, excludeUserId),
        isNull(users.deletedAt),
        eq(users.status, 'active'),
        inArray(users.roleId, [ROLE_IDS.admin, ROLE_IDS.superadmin]),
      ),
    );
  return row?.total ?? 0;
}
