import { and, count, countDistinct, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents, type NewSecurityEvent, type SecurityEvent } from '@/lib/db/schema';

export async function insertSecurityEvent(data: NewSecurityEvent): Promise<void> {
  const db = getDb();
  await db.insert(securityEvents).values(data);
}

export type RecentSecurityEvent = Pick<SecurityEvent, 'eventType' | 'ipMasked' | 'createdAt' | 'metadata'>;

/** 許可する metadata キーだけを残す（§45: metadata に機密値を保存しない）。 */
const ALLOWED_METADATA_KEYS = new Set([
  'device',
  'provider',
  'scope',
  'state_present',
  'notified',
  'kind',
  'self',
  'all',
  'clientId',
  'level',
  'signals',
  'action',
]);

function filterMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(([key]) => ALLOWED_METADATA_KEYS.has(key)),
  );
}

/**
 * 本人のイベントだけを、直近 limit 件だけ返す（§21 / §37 / D-30-15）。
 * 生 IP と user_agent は SQL レベルで取得しない。読み取り専用 GET（§25）。
 */
export async function listRecentSecurityEventsByUser(
  userId: string,
  limit: number,
): Promise<RecentSecurityEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      eventType: securityEvents.eventType,
      ipMasked: securityEvents.ipMasked,
      createdAt: securityEvents.createdAt,
      metadata: securityEvents.metadata,
    })
    .from(securityEvents)
    .where(eq(securityEvents.userId, userId))
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    eventType: row.eventType,
    ipMasked: row.ipMasked,
    createdAt: row.createdAt,
    metadata: filterMetadata(row.metadata),
  }));
}

/**
 * 直近ウィンドウ内で観測された異なる生 IP の数（§57 の「短時間で複数地域」の代理指標・D-38-01）。
 * 生 IP を返さず件数だけを返す（§45）。
 */
export async function countDistinctRecentIpHashes(userId: string, windowMs: number): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ value: countDistinct(securityEvents.ip) })
    .from(securityEvents)
    .where(and(eq(securityEvents.userId, userId), gte(securityEvents.createdAt, since)));
  return Number(row?.value ?? 0);
}

/** 直近ウィンドウ内の `login_failed` 件数（§57 の「大量ログイン試行」）。 */
export async function countRecentFailedLogins(userId: string, windowMs: number): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ value: count() })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.userId, userId),
        eq(securityEvents.eventType, 'login_failed'),
        gte(securityEvents.createdAt, since),
      ),
    );
  return Number(row?.value ?? 0);
}
