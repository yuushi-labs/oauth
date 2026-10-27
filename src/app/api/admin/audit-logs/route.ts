import { NextRequest, NextResponse } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { listAdminAuditLogs } from '@/lib/db/queries/audit-logs';
import { listQuerySchema } from '@/lib/validate/admin';

/**
 * GET /api/admin/audit-logs — 監査ログ一覧（§11.6 #38 / §61）。
 *
 * **管理者（role ≥ admin）以上のみ**。一般ユーザーは `withAdminPipeline` の `FORBIDDEN`（403）で遮断される。
 * 返すのは `admin_audit_logs` のみで、`security_events` は含めない（D-35-07）。
 */
export async function GET(request: NextRequest) {
  return withAdminPipeline(request, 'read', async () => {
    const { limit, offset } = listQuerySchema.parse({
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
      offset: request.nextUrl.searchParams.get('offset') ?? undefined,
    });

    const { logs, total } = await listAdminAuditLogs({ limit, offset });

    return NextResponse.json(
      {
        success: true,
        data: {
          logs: logs.map((log) => ({
            id: log.id,
            action: log.action,
            actor_user_id: log.actorUserId,
            actor_username: log.actorUsername,
            target_user_id: log.targetUserId,
            target_username: log.targetUsername,
            ip_masked: log.ipMasked,
            metadata: log.metadata,
            created_at: log.createdAt.toISOString(),
          })),
          total,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
