import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, securityEvents, sessions, users, webauthnChallenges } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { eq } from 'drizzle-orm';
import { protectRateLimitKey, rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import type { SessionData } from '@/lib/auth/session';

/**
 * Passkey / WebAuthn の実 HTTP テスト共通ヘルパー（§11）。
 *
 * Route Handler を直接呼ぶ。cookie の書込みは request scope 外だと throw するため、
 * 各テストファイルの先頭で `vi.mock('next/headers', ...)` を置くこと（D-32-17 / BUG-15）。
 */
export const APP_URL = 'http://localhost:3000';
export const ANON_SECRET = 'anon-secret-passkey';
export const ANON_SIGNED = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43))
  .update(ANON_SECRET)
  .digest('hex');

let seq = 0;
export function uniq(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(seq += 1)}`;
}

export type TestUser = { id: string; email: string; username: string; password: string };

export async function makeUser(
  options: { emailVerified?: boolean; password?: string | null } = {},
): Promise<TestUser> {
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  const username = uniq('u');
  const password = options.password === undefined ? 'Strong-Password-2026!' : options.password;
  await createUser({
    id,
    username,
    email,
    emailVerified: options.emailVerified ?? true,
    passwordHash: password === null ? null : await hashPassword(password),
    status: options.emailVerified === false ? 'pending_email' : 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  return { id, email, username, password: password ?? '' };
}

export function sessionFor(
  userId: string,
  options: { totpPending?: boolean; reauthed?: boolean } = {},
): SessionData {
  return {
    id: `ses_${uniq('s')}`,
    userId,
    sessionHash: `hash-${uniq('h')}`,
    csrfSecret: 'csrf-secret',
    userAgent: 'vitest',
    ip: '127.0.0.1',
    ipMasked: '127.0.0.0',
    ipHash: null,
    deviceName: 'vitest',
    reauthVerifiedAt: options.reauthed ? new Date().toISOString() : null,
    totpPending: options.totpPending ?? false,
  };
}

export async function persistSession(session: SessionData): Promise<void> {
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(session.sessionHash).digest('hex');
  await getDb().execute(sql`
    INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at,
                          ip_masked, device_name, reauth_verified_at, totp_pending)
    VALUES (${session.id}, ${session.userId}, ${sessionHash}, ${session.csrfSecret}, ${session.userAgent},
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '1 day', ${session.ipMasked}, ${session.deviceName},
            ${session.reauthVerifiedAt ? new Date(session.reauthVerifiedAt) : null}, ${session.totpPending})
  `);
}

/** 認証済みセッションでのリクエスト（Origin / CSRF 付き）。 */
export function authedRequest(
  path: string,
  session: SessionData,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: APP_URL,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_session=${session.sessionHash}`,
      'x-csrf-token': deriveCsrfToken(session),
      ...extraHeaders,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

/** 未認証リクエスト（anon cookie + CSRF 付き）。 */
export function anonRequest(
  path: string,
  method: 'POST',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: APP_URL,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_anon=${ANON_SECRET}.${ANON_SIGNED}`,
      'x-csrf-token': ANON_SECRET,
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });
}

/** セッションの `reauth_verified_at` を「今」に更新する（強い再認証を通すため）。 */
export async function markReauthed(session: SessionData): Promise<void> {
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(session.sessionHash).digest('hex');
  await getDb().execute(sql`
    UPDATE sessions SET reauth_verified_at = NOW() WHERE session_hash = ${sessionHash}
  `);
}

/** Passkey の IP レート制限を消す（テスト間で同じ 127.0.0.1 を共有するため）。 */
export async function clearPasskeyRateLimits(): Promise<void> {
  const pool = (await import('@/lib/db/client')).getPool();
  // Route Handler を直接叩くと `request.ip` が無いため、IP は `0.0.0.0` に落ちる
  // （`getClientIp` の既定）。テストが使う両方の値を消す。
  const keys = ['0.0.0.0', '127.0.0.1'].map((ip) => protectRateLimitKey(rateLimitKeys.passkeyIp(ip)));
  await pool.query('DELETE FROM rate_limit_reservations WHERE key = ANY($1::text[])', [keys]);
  await pool.query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
}

/** テストで作った行を片付ける。 */
export async function cleanupPasskeyRows(userIds: string[], sessionIds: string[]): Promise<void> {
  const db = getDb();
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id));
  for (const id of userIds) {
    await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, id));
    await db.execute(sql`DELETE FROM webauthn_credentials WHERE user_id = ${id}`);
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
