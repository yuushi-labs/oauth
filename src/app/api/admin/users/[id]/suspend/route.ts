import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { suspendUser } from '@/lib/db/queries/admin';
import { revokeAllSessions, getRequestClientIp } from '@/lib/auth/session';
import { recordAdminAudit } from '@/lib/auth/audit';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * POST /api/admin/users/{id}/suspend — ユーザーを停止する（§11.6 #36）。
 *
 * 対象の**全セッションを失効**させる（§23）。自己ロックアウトを避けるため自分自身は対象外（D-35-10）。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    await suspendUser(target.id);
    await revokeAllSessions(target.id, 'admin_suspend');
    await recordSecurityEvent('account_suspended', target.id, ip, userAgent, { by: user.id });
    await recordAdminAudit({
      action: 'admin_user_suspended',
      actorUserId: user.id,
      actorUsername: user.username,
      targetUserId: target.id,
      targetUsername: target.username,
      ip,
      userAgent,
      metadata: { status: 'suspended' },
    });

    return handleSuccess({ user: { id: target.id, status: 'suspended' } });
  });
}
