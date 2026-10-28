import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, ROLE_IDS, securityEvents, sessions, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import type { SessionData } from '@/lib/auth/session';

/**
 * テスト用のユーザー生成と片付けを 1 か所に集約する（D-38-06）。
 *
 * 各テストが個別に `INSERT INTO users ...` を書くと、`status` と `email_verified` の
 * CHECK 制約（`users_status_email_verified_chk`）を踏み抜いて不整合を生む。ここで
 * 「正しい組み合わせ」だけを生成できるようにする。
 *
 * 時間依存テストは `vi.useFakeTimers()` を使い、実時間待ちをしないこと（P8-07★）。
 */
export const STRONG_PASSWORD = 'Strong-Password-2026!';

let seq = 0;
export function uniq(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(seq += 1)}`;
}

export type FixtureKind = 'normal' | 'unverified' | 'suspended' | 'no_password' | 'admin';

export type FixtureUser = {
  id: string;
  email: string;
  username: string;
  password: string;
  kind: FixtureKind;
};

export type FixtureOptions = { kind?: FixtureKind; password?: string | null; emailVerified?: boolean };

function fieldsFor(kind: FixtureKind): { status: string; emailVerified: boolean; roleId: string } {
  switch (kind) {
    case 'unverified':
      return { status: 'pending_email', emailVerified: false, roleId: DEFAULT_ROLE_ID };
    case 'suspended':
      return { status: 'suspended', emailVerified: true, roleId: DEFAULT_ROLE_ID };
    case 'admin':
      return { status: 'active', emailVerified: true, roleId: ROLE_IDS.admin };
    case 'normal':
    case 'no_password':
    default:
      return { status: 'active', emailVerified: true, roleId: DEFAULT_ROLE_ID };
  }
}

/** ユーザーを 1 人作る。kind ごとに status / emailVerified / roleId を正しく揃える。 */
export async function makeFixtureUser(options: FixtureOptions = {}): Promise<FixtureUser> {
  const kind = options.kind ?? 'normal';
  const id = `usr_${uniq('t')}`;
  const email = `${uniq('m')}@example.com`;
  const username = uniq('u');
  const noPassword = kind === 'no_password' || options.password === null;
  const password = noPassword ? '' : (options.password ?? STRONG_PASSWORD);
  const { status, emailVerified, roleId } = fieldsFor(kind);

  await createUser({
    id,
    username,
    email,
    emailVerified: options.emailVerified ?? emailVerified,
    passwordHash: noPassword ? null : await hashPassword(password),
    status,
    roleId,
  });
  return { id, email, username, password, kind };
}

export function fixtureSession(userId: string, overrides: Partial<SessionData> = {}): SessionData {
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
    reauthVerifiedAt: null,
    totpPending: false,
    ...overrides,
  };
}

/** セッション行を直接永続化する（`session_hash` は pepper で HMAC して保存する）。 */
export async function persistFixtureSession(session: SessionData): Promise<void> {
  const { createHmac } = await import('node:crypto');
  const sessionHash = createHmac('sha256', process.env.SESSION_PEPPER!).update(session.sessionHash).digest('hex');
  await getDb().execute(sql`
    INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at,
                          ip_hash, ip_masked, device_name, reauth_verified_at, totp_pending)
    VALUES (${session.id}, ${session.userId}, ${sessionHash}, ${session.csrfSecret}, ${session.userAgent},
            NOW() + INTERVAL '1 hour', NOW() + INTERVAL '1 day', ${session.ipHash}, ${session.ipMasked},
            ${session.deviceName}, ${session.reauthVerifiedAt ? new Date(session.reauthVerifiedAt) : null},
            ${session.totpPending})
  `);
}

/** テストで作ったユーザーと従属行を片付ける（security_events / sessions / users）。 */
export async function cleanupFixtureUsers(userIds: string[]): Promise<void> {
  const db = getDb();
  for (const id of userIds) {
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
