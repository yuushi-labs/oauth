import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { purgeDeletedUsers } from '../../../scripts/purge-expired';

/**
 * Phase 9（§24 / D-13 / D-35-08）: 論理削除済みユーザーの物理削除。
 *
 * 保持期間（30 日）経過後に `users` を物理削除したとき、
 * - 本人データ（sessions / totp / recovery_codes / webauthn_credentials / accounts）は CASCADE で消える
 * - `security_events` / `oauth_clients.owner_user_id` / `admin_audit_logs` は SET NULL で匿名化して残る
 * ことを実 PostgreSQL で検証する。
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const db = drizzle(pool);

const suffix = Date.now().toString(36);
const oldUser = `usr_purge_old_${suffix}`;
const recentUser = `usr_purge_recent_${suffix}`;
const clientId = `cli_purge_${suffix}`;

async function insertUser(id: string, deletedDaysAgo: number | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, username, email, email_verified, status, role_id, deleted_at)
    VALUES (${id}, ${id}, ${`${id}@example.com`}, false, 'deleted', 'role_user',
            ${deletedDaysAgo === null ? null : sql`NOW() - (${deletedDaysAgo} || ' days')::interval`})
  `);
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM admin_audit_logs WHERE actor_username = ${oldUser} OR target_username = ${oldUser}`);
  await db.execute(sql`DELETE FROM security_events WHERE metadata->>'probe' = ${suffix}`);
  await db.execute(sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${oldUser}, ${recentUser})`);
  await pool.end();
});

describe('purgeDeletedUsers', () => {
  it('保持期間を過ぎた論理削除ユーザーを物理削除し、関連行を CASCADE / SET NULL で処理する', async () => {
    await insertUser(oldUser, 31);
    await insertUser(recentUser, 1);

    await db.execute(sql`INSERT INTO sessions (id, user_id, session_hash, csrf_secret, expires_at, absolute_expires_at)
      VALUES (${`ses_${suffix}`}, ${oldUser}, ${`h_${suffix}`}, 'csrf', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days')`);
    await db.execute(sql`INSERT INTO totp (user_id, secret_encrypted) VALUES (${oldUser}, 'enc')`);
    await db.execute(sql`INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (${`rc_${suffix}`}, ${oldUser}, ${`ch_${suffix}`})`);
    await db.execute(sql`INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key)
      VALUES (${`wc_${suffix}`}, ${oldUser}, ${`cred_${suffix}`}, 'pk')`);
    await db.execute(sql`INSERT INTO accounts (id, user_id, provider, provider_account_id)
      VALUES (${`acc_${suffix}`}, ${oldUser}, 'google', ${`sub_${suffix}`})`);
    await db.execute(sql`INSERT INTO security_events (id, user_id, event_type, metadata)
      VALUES (${`evt_${suffix}`}, ${oldUser}, 'login_success', ${sql`jsonb_build_object('probe', ${suffix}::text)`})`);
    await db.execute(sql`INSERT INTO oauth_clients (client_id, name, client_type, redirect_uris, token_endpoint_auth_method, owner_user_id)
      VALUES (${clientId}, 'purge test', 'public', ${sql`'["https://example.com/cb"]'::jsonb`}, 'none', ${oldUser})`);
    await db.execute(sql`INSERT INTO admin_audit_logs (id, actor_user_id, actor_username, action, target_user_id, target_username)
      VALUES (${`aud_${suffix}`}, ${oldUser}, ${oldUser}, 'admin_account_deleted', ${oldUser}, ${oldUser})`);

    const purged = await purgeDeletedUsers(db);
    expect(purged).toBe(1);

    const remaining = await db.execute(sql`SELECT id FROM users WHERE id IN (${oldUser}, ${recentUser}) ORDER BY id`);
    expect(remaining.rows).toEqual([{ id: recentUser }]);

    for (const table of ['sessions', 'totp', 'recovery_codes', 'webauthn_credentials', 'accounts']) {
      const rows = await db.execute(sql`SELECT 1 FROM ${sql.raw(table)} WHERE user_id = ${oldUser}`);
      expect(rows.rows, `${table} should be cascaded`).toEqual([]);
    }

    const events = await db.execute(sql`SELECT user_id FROM security_events WHERE id = ${`evt_${suffix}`}`);
    expect(events.rows).toEqual([{ user_id: null }]);

    const clients = await db.execute(sql`SELECT owner_user_id FROM oauth_clients WHERE client_id = ${clientId}`);
    expect(clients.rows).toEqual([{ owner_user_id: null }]);

    const audits = await db.execute(sql`SELECT actor_user_id, target_user_id, actor_username FROM admin_audit_logs WHERE id = ${`aud_${suffix}`}`);
    expect(audits.rows).toEqual([{ actor_user_id: null, target_user_id: null, actor_username: oldUser }]);
  });
});
