import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { totp, recoveryCodes, type Totp } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';

export async function findTotpByUserId(userId: string): Promise<Totp | null> {
  const db = getDb();
  const [row] = await db.select().from(totp).where(eq(totp.userId, userId)).limit(1);
  return row ?? null;
}

/**
 * secret を保存する（未確認の `enabled=false` で upsert）。再 setup は上書きを許す（D-33-16）。
 * 有効化済みの拒否はルート側で行う（ここでは状態を見ない）。
 */
export async function upsertTotpPending(userId: string, secretEncrypted: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(totp)
    .values({ userId, secretEncrypted, enabled: false, lastUsedCounter: -1, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: totp.userId,
      set: { secretEncrypted, enabled: false, lastUsedCounter: -1, confirmedAt: null, updatedAt: now },
    });
}

export async function enableTotp(userId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(totp)
    .set({ enabled: true, confirmedAt: now, updatedAt: now })
    .where(eq(totp.userId, userId));
}

/**
 * 一致した counter を atomic に消費する（D-33-04）。
 * `last_used_counter < counter` の単調増加のみ許可するので、古い counter での replay も弾ける（T13）。
 * 戻り値が false なら「既に誰かがその counter を消費した」= replay。
 *
 * 単文 UPDATE の更新行数で判定する（read → 判定 → write の 2 段書き禁止・D-16）。
 *
 * `allowPending` は有効化前（`enabled = false` の保留行）の消費を許可する。setup → verify の
 * 有効化フローは、まだ `enabled = false` の行に対してコード検証・counter 消費を行うため（§8.3）。
 * 既定は `false`（有効行のみ）。
 */
export async function consumeTotpCounter(
  userId: string,
  counter: number,
  options: { allowPending?: boolean } = {},
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE totp SET last_used_counter = $2, updated_at = now()
     WHERE user_id = $1 AND last_used_counter < $2 AND (enabled = true OR $3 = true)`,
    [userId, counter, options.allowPending ?? false],
  );
  return result.rowCount === 1;
}

export async function deleteTotp(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(totp).where(eq(totp.userId, userId));
}

/**
 * 有効化とリカバリーコード保存を**同一トランザクション**で行う（§8.3）。
 * 片方だけ成功すると復旧不能になるため、行を分けない。
 */
export async function enableTotpWithRecoveryCodes(
  userId: string,
  recoveryCodeHashes: string[],
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(totp)
      .set({ enabled: true, confirmedAt: now, updatedAt: now })
      .where(eq(totp.userId, userId));
    if (recoveryCodeHashes.length > 0) {
      await tx.insert(recoveryCodes).values(
        recoveryCodeHashes.map((codeHash) => ({
          id: newId('tok'),
          userId,
          codeHash,
          createdAt: now,
        })),
      );
    }
  });
}
