import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import type { DbClient } from '@/lib/db/client';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BATCH_SIZE = 1000;

export async function purgeExpired(db: Pick<DbClient, 'execute'> = getDb()): Promise<Record<string, number>> {
  const jobs = [
    ['reservation', sql`DELETE FROM rate_limit_reservations WHERE reservation_id IN (
      SELECT reservation_id FROM rate_limit_reservations
      WHERE expires_at < NOW() AND status IN ('confirmed', 'released', 'expired')
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING reservation_id`],
    ['expired reservation', sql`UPDATE rate_limit_reservations SET status = 'expired'
      WHERE reservation_id IN (
        SELECT reservation_id FROM rate_limit_reservations
        WHERE expires_at < NOW() AND status = 'active'
        ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) RETURNING reservation_id`],
    ['rate limit counter', sql`DELETE FROM rate_limit_hits WHERE key IN (
      SELECT h.key FROM rate_limit_hits h
      WHERE h.window_expires_at < NOW() AND NOT EXISTS (
        SELECT 1 FROM rate_limit_reservations r WHERE r.key = h.key AND r.status = 'active'
      )
      ORDER BY h.window_expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING key`],
    ['email verification token', sql`DELETE FROM email_verification_tokens WHERE id IN (
      SELECT id FROM email_verification_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`],
    ['password reset token', sql`DELETE FROM password_reset_tokens WHERE id IN (
      SELECT id FROM password_reset_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`],
    ['email change request', sql`DELETE FROM email_change_requests WHERE id IN (
      SELECT id FROM email_change_requests WHERE expires_at < NOW() OR used_at IS NOT NULL
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`],
    ['session', sql`DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions WHERE
        (revoked_at IS NULL AND (expires_at < NOW() OR absolute_expires_at < NOW())) OR
        (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`],
    ['OIDC artifact', sql`DELETE FROM oidc_artifacts WHERE (model, id_hash) IN (
      SELECT model, id_hash FROM oidc_artifacts
      WHERE expires_at < NOW() OR consumed_at < NOW() - INTERVAL '1 day'
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id_hash`],
    ['revoked OIDC grant', sql`DELETE FROM oidc_user_grants WHERE id IN (
      SELECT id FROM oidc_user_grants WHERE revoked_at < NOW() - INTERVAL '30 days'
      ORDER BY revoked_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id`],
    // 期限切れは即削除。消費済みは 1 時間だけ残す（直後のデバッグ用・D-31-17）。
    ['oauth state', sql`DELETE FROM oauth_states WHERE state_hash IN (
      SELECT state_hash FROM oauth_states
      WHERE expires_at < NOW() OR consumed_at < NOW() - INTERVAL '1 hour'
      ORDER BY expires_at ASC LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING state_hash`],
  ] as const;
  const results = await Promise.all(jobs.map(async ([label, statement]) => [label, await deleteInBatches(db, statement)] as const));
  return Object.fromEntries(results);
}

async function deleteInBatches(db: Pick<DbClient, 'execute'>, statement: ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  while (true) {
    const result = await db.execute(statement);
    const removed = result.rows.length;
    total += removed;
    if (removed < BATCH_SIZE) return total;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void import('dotenv/config').then(async () => {
    try {
      const results = await purgeExpired();
      for (const [label, total] of Object.entries(results)) process.stdout.write(`${label}: ${total}\n`);
    } catch {
      process.stderr.write('purge-expired failed\n');
      process.exitCode = 1;
    } finally {
      await getPool().end();
    }
  });
}
