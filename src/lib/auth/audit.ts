import { getDb } from '@/lib/db/client';
import { adminAuditLogs, type AdminAuditAction } from '@/lib/db/schema';
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

export type AdminAuditInput = {
  action: AdminAuditAction;
  actorUserId: string;
  targetUserId?: string | null;
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
    await db.insert(adminAuditLogs).values({
      id: newId('aud'),
      actorUserId: input.actorUserId,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
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
