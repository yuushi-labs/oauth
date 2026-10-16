import { randomBytes } from 'node:crypto';
import { getPool } from '@/lib/db/client';

export async function ensureSubject(userId: string, clientId: string): Promise<string | null> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO oidc_user_subjects (user_id, client_id, subject) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, client_id) DO NOTHING`,
    [userId, clientId, `sub_${randomBytes(32).toString('base64url')}`],
  );
  const result = await pool.query<{ subject: string }>(
    'SELECT subject FROM oidc_user_subjects WHERE user_id = $1 AND client_id = $2', [userId, clientId],
  );
  return result.rows[0]?.subject ?? null;
}

export async function subjectOwner(subject: string): Promise<string | null> {
  const result = await getPool().query<{ user_id: string }>(
    'SELECT user_id FROM oidc_user_subjects WHERE subject = $1 LIMIT 1', [subject],
  );
  return result.rows[0]?.user_id ?? null;
}