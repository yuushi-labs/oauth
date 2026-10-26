import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { users, webauthnChallenges, webauthnCredentials, type WebauthnCredential } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';

export async function insertCredential(data: {
  userId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[] | null;
  aaguid: string | null;
  deviceName: string | null;
  backedUp: boolean;
}): Promise<WebauthnCredential> {
  const db = getDb();
  const [row] = await db
    .insert(webauthnCredentials)
    .values({
      id: newId('wac'),
      userId: data.userId,
      credentialId: data.credentialId,
      publicKey: data.publicKey,
      signCount: data.signCount,
      transports: data.transports,
      aaguid: data.aaguid,
      deviceName: data.deviceName,
      backedUp: data.backedUp,
      createdAt: new Date(),
    })
    .returning();
  if (!row) throw new Error('credential の保存に失敗しました');
  return row;
}

export async function listCredentialsByUser(userId: string): Promise<WebauthnCredential[]> {
  const db = getDb();
  return db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(desc(webauthnCredentials.createdAt));
}

export async function countCredentialsByUser(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  return row?.count ?? 0;
}

/** 内部 ID（`wac_`）と owner で引く。他人の credential は返さない（§49）。 */
export async function findCredentialByIdForUser(
  id: string,
  userId: string,
): Promise<WebauthnCredential | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * ログイン時に credential → user を解決する。**削除済みユーザーの credential は返さない**
 * （§24 / §48「credential 削除後の認証」）。`status` の判定は呼び出し側で行う。
 */
export async function findCredentialByCredentialId(
  credentialId: string,
): Promise<WebauthnCredential | null> {
  const db = getDb();
  const [row] = await db
    .select({ credential: webauthnCredentials })
    .from(webauthnCredentials)
    .innerJoin(users, eq(users.id, webauthnCredentials.userId))
    .where(and(eq(webauthnCredentials.credentialId, credentialId), isNull(users.deletedAt)))
    .limit(1);
  return row?.credential ?? null;
}

/** owner 確認つき削除（IDOR 防止・§49）。削除できたら true。 */
export async function deleteCredential(id: string, userId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
    .returning({ id: webauthnCredentials.id });
  return rows.length === 1;
}

export async function deleteCredentialsByUser(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .returning({ id: webauthnCredentials.id });
  return rows.length;
}

/**
 * `sign_count` を atomic に進める（D-34-06）。
 *
 * - `newCounter === 0`（カウンタ非対応の authenticator・プラットフォーム passkey 等）は
 *   **後退判定をせず** `last_used_at` のみ更新する。単調増加を要求すると正規ログインが全滅する。
 * - `newCounter > 0` は `sign_count < newCounter` の**単文 UPDATE** で単調増加のみ許可する。
 *   戻り値が false なら「並行 replay かクローン」= 消費失敗。
 *
 * 単文 UPDATE の更新行数で判定する（read → 判定 → write の 2 段書き禁止・D-16）。
 */
export async function advanceSignCount(args: {
  credentialId: string;
  userId: string;
  newCounter: number;
}): Promise<boolean> {
  if (args.newCounter === 0) {
    const result = await getPool().query(
      `UPDATE webauthn_credentials SET last_used_at = now()
       WHERE credential_id = $1 AND user_id = $2`,
      [args.credentialId, args.userId],
    );
    return result.rowCount === 1;
  }
  const result = await getPool().query(
    `UPDATE webauthn_credentials SET sign_count = $3, last_used_at = now()
     WHERE credential_id = $1 AND user_id = $2 AND sign_count < $3`,
    [args.credentialId, args.userId, args.newCounter],
  );
  return result.rowCount === 1;
}

export async function insertChallenge(data: {
  userId: string | null;
  type: 'registration' | 'authentication';
  challenge: string;
  expiresAt: Date;
}): Promise<string> {
  const db = getDb();
  const id = newId('wch');
  await db.insert(webauthnChallenges).values({
    id,
    userId: data.userId,
    type: data.type,
    challenge: data.challenge,
    expiresAt: data.expiresAt,
    createdAt: new Date(),
  });
  return id;
}

/**
 * challenge を **1 回限り**で消費する（D-34-05 / D-16）。
 *
 * 単文 UPDATE の更新行数 = 1 のときだけ成功する。`user_id` の照合で**他人の challenge を
 * 消費できない**ようにする（登録・再認証は `user_id` を入れる。discoverable ログインは
 * `user_id IS NULL` を許容する）。一致・未消費・期限内・type 一致のすべてを WHERE で課す。
 */
export async function consumeChallengeRow(args: {
  id: string;
  type: 'registration' | 'authentication';
  userId: string | null;
}): Promise<{ challenge: string; userId: string | null } | null> {
  const result = await getPool().query<{ challenge: string; user_id: string | null }>(
    `UPDATE webauthn_challenges SET consumed_at = now()
     WHERE id = $1 AND type = $2
       AND consumed_at IS NULL AND expires_at > now()
       AND (user_id = $3 OR user_id IS NULL)
     RETURNING challenge, user_id`,
    [args.id, args.type, args.userId],
  );
  const row = result.rows[0];
  return row ? { challenge: row.challenge, userId: row.user_id } : null;
}

/** 掃除ジョブ用（D-34-16）: 期限切れ、または消費後 1 日経過した challenge を削除する。 */
export async function deleteExpiredChallenges(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM webauthn_challenges
     WHERE expires_at < now() OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')`,
  );
  return result.rowCount ?? 0;
}
