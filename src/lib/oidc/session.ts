import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getEnv } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { getSessionCookieName } from '@/lib/auth/cookie';

export type OidcAppSession = { id: string; sessionId: string; username: string; createdAt: Date };

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export async function currentOidcAppSession(req: IncomingMessage): Promise<OidcAppSession | null> {
  const token = cookieValue(req, getSessionCookieName());
  if (!token) return null;
  const sessionHash = createHmac('sha256', getEnv().SESSION_PEPPER).update(token).digest('hex');
  const result = await getPool().query<OidcAppSession>(
    `SELECT s.user_id AS id, s.id AS "sessionId", u.username, s.created_at AS "createdAt"
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.session_hash = $1 AND s.revoked_at IS NULL
       AND s.expires_at > now() AND s.absolute_expires_at > now()
       AND s.totp_pending = false
       AND u.status = 'active' AND u.email_verified = true AND u.deleted_at IS NULL
     LIMIT 1`,
    [sessionHash],
  );
  return result.rows[0] ?? null;
}

export async function blockedOidcAccount(req: IncomingMessage): Promise<{ userId: string; status: string } | null> {
  const token = cookieValue(req, getSessionCookieName());
  if (!token) return null;
  const sessionHash = createHmac('sha256', getEnv().SESSION_PEPPER).update(token).digest('hex');
  const result = await getPool().query<{ user_id: string; status: string; email_verified: boolean; deleted_at: Date | null }>(
    `SELECT s.user_id, u.status, u.email_verified, u.deleted_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.session_hash = $1 AND s.revoked_at IS NULL
       AND s.expires_at > now() AND s.absolute_expires_at > now()
     LIMIT 1`,
    [sessionHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status === 'active' && row.email_verified && !row.deleted_at) return null;
  return { userId: row.user_id, status: row.deleted_at ? 'deleted' : row.status };
}
