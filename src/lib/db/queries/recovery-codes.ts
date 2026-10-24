import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { recoveryCodes } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';

export async function insertRecoveryCodes(
  rows: { userId: string; codeHash: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db.insert(recoveryCodes).values(
    rows.map((row) => ({
      id: newId('tok'),
      userId: row.userId,
      codeHash: row.codeHash,
      createdAt: new Date(),
    })),
  );
}

/**
 * 1 個を atomic に消費する（D-33-12）。単文 UPDATE の更新行数 = 1 でのみ成功。
 * 使用済み・不一致は 0 行更新。
 */
export async function consumeRecoveryCodeRow(userId: string, codeHash: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE recovery_codes SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, codeHash],
  );
  return result.rowCount === 1;
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return row?.count ?? 0;
}

export async function deleteAllRecoveryCodes(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}
