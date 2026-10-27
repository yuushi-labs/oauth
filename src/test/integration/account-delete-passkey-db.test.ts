import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { deleteCredentialsByUser } from '@/lib/db/queries/webauthn';

/**
 * 仕様 §24 / issue #19: アカウント削除で Passkey を無効化する。
 *
 * 実 PostgreSQL で `deleteCredentialsByUser` が該当ユーザーの `webauthn_credentials` を
 * 0 件にすることを固定する（Route Handler 側の呼び出しは
 * `account-delete-passkey.test.ts` が担当）。
 */

const userId = newId('usr');

afterAll(async () => {
  await getDb().execute(sql`DELETE FROM webauthn_credentials WHERE user_id = ${userId}`);
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('Integration - deleteCredentialsByUser は credential を 0 件にする（§24）', () => {
  it('該当ユーザーの credential を削除する', async () => {
    await getPool().query(
      `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
       VALUES ($1, $2, $3, true, 'hashed', 'active', $4)`,
      [userId, `pk_del_${Date.now().toString(36)}`, `${userId}@example.com`, DEFAULT_ROLE_ID],
    );
    await getPool().query(
      `INSERT INTO webauthn_credentials
         (id, user_id, credential_id, public_key, sign_count, transports, aaguid, device_name, backed_up, created_at)
       VALUES ($1, $2, $3, 'pk', 0, NULL, NULL, 'iPhone', false, now())`,
      [newId('wac'), userId, newId('wch')],
    );

    const before = await getPool().query(
      `SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`, [userId],
    );
    expect(before.rows[0].n).toBe(1);

    const removed = await deleteCredentialsByUser(userId);
    expect(removed).toBe(1);

    const after = await getPool().query(
      `SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`, [userId],
    );
    expect(after.rows[0].n).toBe(0);
  });
});
