import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '@/lib/db/client';
import { adminAuditLogs, users } from '@/lib/db/schema';

/**
 * 監査ログの一覧（§61）。`admin_audit_logs` **のみ**を返し、`security_events` は含めない。
 * 呼び出しは管理 API（`requireAdminAccess` 済み）からのみに限定する（D-35-07）。
 */
export type AdminAuditLogRow = {
  id: string;
  action: string;
  actorUserId: string;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  ipMasked: string | null;
  metadata: unknown;
  createdAt: Date;
};

export async function listAdminAuditLogs(options: {
  limit: number;
  offset: number;
}): Promise<{ logs: AdminAuditLogRow[]; total: number }> {
  const db = getDb();
  const actor = alias(users, 'actor_user');
  const target = alias(users, 'target_user');

  const rows = await db
    .select({
      id: adminAuditLogs.id,
      action: adminAuditLogs.action,
      actorUserId: adminAuditLogs.actorUserId,
      actorUsername: actor.username,
      targetUserId: adminAuditLogs.targetUserId,
      targetUsername: target.username,
      ipMasked: adminAuditLogs.ipMasked,
      metadata: adminAuditLogs.metadata,
      createdAt: adminAuditLogs.createdAt,
    })
    .from(adminAuditLogs)
    .leftJoin(actor, eq(actor.id, adminAuditLogs.actorUserId))
    .leftJoin(target, eq(target.id, adminAuditLogs.targetUserId))
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(options.limit)
    .offset(options.offset);

  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(adminAuditLogs);

  return { logs: rows, total: countRow?.total ?? 0 };
}

/** テスト・検証用: 特定 actor のログだけを引く（管理 API では使わない）。 */
export async function findAdminAuditLogById(id: string) {
  const db = getDb();
  const [row] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, id)).limit(1);
  return row ?? null;
}
