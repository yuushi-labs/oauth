import { and, eq, isNull } from 'drizzle-orm';
import { getDb, type DbClient } from '@/lib/db/client';
import { sessions, type NewSession } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { randomToken } from '@/lib/util/crypto';
import { hashIp, maskIp } from '@/lib/util/ip';
import { getEnv } from '@/lib/env';
import { createHmac, randomBytes } from 'node:crypto';
import { deriveDeviceName } from '@/lib/util/device';

export type SessionData = {
  id: string;
  userId: string;
  sessionHash: string;
  csrfSecret: string;
  userAgent: string;
  ip: string;
  ipMasked: string | null;
  ipHash: string | null;
  deviceName: string;
  reauthVerifiedAt: string | null;
  /** 2FA の保留セッション（パスワード認証済み・コード未検証）。昇格まで封じ込める（D-33-07）。 */
  totpPending: boolean;
};

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30日
const SESSION_ABSOLUTE_MAX_AGE = 90 * 24 * 60 * 60; // 90日
const LAST_SEEN_THRESHOLD = 15 * 60 * 1000; // 15分

export function getClientIp(headers: Headers, socketIp?: string | null): string {
  const env = getEnv();
  const trustedHeader = env.TRUSTED_PROXY_HEADER?.toLowerCase();
  if (env.TRUSTED_PROXY_HOPS > 0 && trustedHeader) {
    const forwarded = headers.get(trustedHeader);
    const values = forwarded?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
    const index = Math.max(0, values.length - env.TRUSTED_PROXY_HOPS - 1);
    if (values[index]) return values[index];
  }
  // Forwarding headers are attacker controlled unless a trusted proxy is explicitly configured.
  return socketIp?.trim() || '0.0.0.0';
}

export function getRequestClientIp(request: { headers: Headers; ip?: string | null }): string {
  return getClientIp(request.headers, request.ip);
}

function getUserAgent(headers: Headers): string {
  return headers.get('user-agent') ?? '';
}

async function createSessionInternal(
  userId: string,
  request: { headers: Headers },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  options: {
    /**
     * 「このセッションはたった今、本人確認が終わった」印。
     * OAuth ログインの完了時に true を渡すことで、**パスワード未設定の social-only ユーザーも**
     * 再認証（reauth）を 5 分間使えるようにする。social-only ユーザーはパスワードが無いので
     * `POST /api/auth/reauth` が原理的に成立せず、reauth 必須の操作（link / unlink）が
     * 永久に実行できなくなるため（Phase 4）。
     */
    reauthVerified?: boolean;
    totpPending?: boolean;
    /** セッションの絶対 TTL（秒）。既定は 30 日。管理者は 8 時間（§51・D-35-03）。 */
    sessionMaxAgeSeconds?: number;
  } = {},
): Promise<{ token: string; session: SessionData }> {
  const token = `sess_${randomToken(32)}`;
  const env = getEnv();
  const sessionHash = createHmac('sha256', env.SESSION_PEPPER).update(token).digest('hex');
  const csrfSecret = randomBytes(32).toString('base64url');
  const ip = getRequestClientIp(request);
  const ipMasked = maskIp(ip);
  const ipHash = hashIp(ip, env.IP_HASH_PEPPER);
  const userAgent = getUserAgent(request.headers);
  const deviceName = deriveDeviceName(userAgent);

  const id = newId('ses');
  const now = new Date();
  const maxAge = options.sessionMaxAgeSeconds ?? SESSION_MAX_AGE;
  const expiresAt = new Date(now.getTime() + maxAge * 1000);
  const absoluteExpiresAt = new Date(
    now.getTime() + Math.min(maxAge, SESSION_ABSOLUTE_MAX_AGE) * 1000,
  );

  const data: NewSession = {
    id,
    userId,
    sessionHash,
    csrfSecret,
    userAgent,
    ipHash,
    ipMasked,
    deviceName,
    expiresAt,
    absoluteExpiresAt,
    lastSeenAt: now,
    totpPending: options.totpPending ?? false,
    ...(options.reauthVerified ? { reauthVerifiedAt: now } : {}),
  };
  await db.insert(sessions).values(data);

  return {
    token,
    session: {
      id,
      userId,
      sessionHash,
      csrfSecret,
      userAgent,
      ip,
      ipMasked,
      ipHash,
      deviceName,
      reauthVerifiedAt: options.reauthVerified ? now.toISOString() : null,
      totpPending: options.totpPending ?? false,
    },
  };
}

export async function createSession(
  userId: string,
  request: { headers: Headers },
  options: { reauthVerified?: boolean; totpPending?: boolean; sessionMaxAgeSeconds?: number } = {},
): Promise<{ token: string; session: SessionData }> {
  const db = getDb();
  return createSessionInternal(userId, request, db, options);
}

export async function getSession(token: string): Promise<SessionData | null> {
  const env = getEnv();
  const sessionHash = createHmac('sha256', env.SESSION_PEPPER).update(token).digest('hex');
  const db = getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionHash, sessionHash))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.absoluteExpiresAt.getTime() <= Date.now()) return null;

  const now = Date.now();
  if (now - row.lastSeenAt.getTime() > LAST_SEEN_THRESHOLD) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.id));
  }

  return {
    id: row.id,
    userId: row.userId,
    sessionHash: row.sessionHash,
    csrfSecret: row.csrfSecret,
    userAgent: row.userAgent,
    ip: '',
    ipMasked: row.ipMasked ?? '',
    ipHash: row.ipHash ?? null,
    deviceName: row.deviceName ?? 'その他のデバイス',
    reauthVerifiedAt: row.reauthVerifiedAt ? row.reauthVerifiedAt.toISOString() : null,
    totpPending: row.totpPending,
  };
}

/** 2FA の保留セッションを昇格させる（同じ行を更新する・D-33-10）。 */
export async function markSessionTotpVerified(id: string): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ totpPending: false }).where(eq(sessions.id, id));
}

export async function revokeSession(id: string, reason: string, replacedBy?: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason, replacedBy })
    .where(eq(sessions.id, id));
}

export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function setReauthVerified(id: string): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ reauthVerifiedAt: new Date() }).where(eq(sessions.id, id));
}
