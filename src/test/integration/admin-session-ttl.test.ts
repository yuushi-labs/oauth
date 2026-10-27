import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { createSession, getSession, revokeSession } from '@/lib/auth/session';
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  sessionMaxAgeSecondsForRole,
} from '@/lib/auth/admin-policy';
import { ROLE_IDS, DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { hashPassword } from '@/lib/auth/password';

/**
 * Phase 7（§51・D-35-03）: 管理者セッションの TTL が 8 時間に短縮されることを実 DB で確認する。
 */

const createdSessionIds: string[] = [];
const userId = newId('usr');

function request(headers: Record<string, string> = {}): { headers: Headers } {
  return { headers: new Headers({ 'user-agent': 'vitest', ...headers }) };
}

afterAll(async () => {
  const db = getDb();
  for (const id of createdSessionIds) {
    await db.execute(sql`DELETE FROM sessions WHERE id = ${id}`);
  }
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('Integration - admin session TTL (§51)', () => {
  it('sessionMaxAgeSecondsForRole は管理者のみ 8 時間を返す', () => {
    expect(sessionMaxAgeSecondsForRole(ROLE_IDS.admin)).toBe(ADMIN_SESSION_MAX_AGE_SECONDS);
    expect(sessionMaxAgeSecondsForRole(ROLE_IDS.superadmin)).toBe(ADMIN_SESSION_MAX_AGE_SECONDS);
    expect(sessionMaxAgeSecondsForRole(DEFAULT_ROLE_ID)).toBeUndefined();
    expect(sessionMaxAgeSecondsForRole(null)).toBeUndefined();
  });

  it('管理者セッションは 8 時間で失効する', async () => {
    await getPool().query(
      `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
       VALUES ($1, $2, $3, true, $4, 'active', $5)`,
      [userId, `ttl_${Date.now().toString(36)}`, `${userId}@example.com`, await hashPassword('Admin-Ttl-Strong-2026!'), ROLE_IDS.admin],
    );

    const { token, session } = await createSession(userId, request(), {
      sessionMaxAgeSeconds: ADMIN_SESSION_MAX_AGE_SECONDS,
    });
    createdSessionIds.push(session.id);

    const { rows } = await getPool().query(
      `SELECT expires_at, absolute_expires_at FROM sessions WHERE id = $1`,
      [session.id],
    );
    const ttlHours = (new Date(rows[0].expires_at).getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(7.9);
    expect(ttlHours).toBeLessThanOrEqual(8.01);

    // 通常セッションは 30 日
    const normal = await createSession(userId, request());
    createdSessionIds.push(normal.session.id);
    const { rows: normalRows } = await getPool().query(
      `SELECT expires_at FROM sessions WHERE id = $1`,
      [normal.session.id],
    );
    const normalDays = (new Date(normalRows[0].expires_at).getTime() - Date.now()) / 86_400_000;
    expect(normalDays).toBeGreaterThan(29.9);

    // 失効させて後始末
    await revokeSession(session.id, 'test_cleanup');
    expect(await getSession(token)).toBeNull();
  });
});
