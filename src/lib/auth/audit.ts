import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { adminAuditLogs, users, type AdminAuditAction } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { maskIp } from '@/lib/util/ip';
import { logger } from '@/lib/util/logger';

/** 監査ログの metadata に残してよいキー（§45・D-35-09）。 */
const ALLOWED_METADATA_KEYS = new Set(['count', 'reason', 'status', 'sessions', 'role', 'previous_role']);

function filterMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const filtered = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => ALLOWED_METADATA_KEYS.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

async function lookupUsername(db: ReturnType<typeof getDb>, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.username ?? null;
}

export type AdminAuditInput = {
  action: AdminAuditAction;
  actorUserId: string;
  /** 呼び出し側が既に持っている場合は渡す（余分な SELECT を避ける）。無ければ DB から引く。 */
  actorUsername?: string | null;
  targetUserId?: string | null;
  targetUsername?: string | null;
  targetSessionId?: string | null;
  ip: string;
  userAgent: string;
  metadata?: Record<string, unknown>;
};

/**
 * 管理者操作の監査ログを追記する（§61）。
 *
 * `security_events` とは別テーブルに保存する（D-35-07）。metadata は許可キーのみを通す（§45）。
 * **記録の失敗で呼び出し元の操作を失敗させない**。失敗は `logger.error` で検知する。
 */
export async function recordAdminAudit(input: AdminAuditInput): Promise<void> {
  try {
    const db = getDb();
    // actor/target の表示名は追記時にスナップショットする。保持期間後のユーザー物理削除で
    // FK が SET NULL になっても、監査一覧に操作主体・対象を表示できるようにする（D-35-08）。
    const actorUsername =
      input.actorUsername ?? (await lookupUsername(db, input.actorUserId));
    const targetUsername =
      input.targetUsername ?? (await lookupUsername(db, input.targetUserId ?? null));

    await db.insert(adminAuditLogs).values({
      id: newId('aud'),
      actorUserId: input.actorUserId,
      actorUsername: actorUsername ?? null,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetUsername: targetUsername ?? null,
      targetSessionId: input.targetSessionId ?? null,
      ip: input.ip,
      ipMasked: input.ip ? maskIp(input.ip) : null,
      userAgent: input.userAgent,
      metadata: filterMetadata(input.metadata),
      createdAt: new Date(),
    });
  } catch (error) {
    logger.error('admin audit log failed', {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
