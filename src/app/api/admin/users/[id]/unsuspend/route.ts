import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { unsuspendUser } from '@/lib/db/queries/admin';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordAdminAudit } from '@/lib/auth/audit';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/** POST /api/admin/users/{id}/unsuspend — 停止を解除する（§11.6）。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const status = await unsuspendUser(target.id);
    await recordSecurityEvent('account_unsuspended', target.id, ip, userAgent, { by: user.id });
    await recordAdminAudit({
      action: 'admin_user_unsuspended',
      actorUserId: user.id,
      actorUsername: user.username,
      targetUserId: target.id,
      targetUsername: target.username,
      ip,
      userAgent,
      metadata: { status },
    });

    return handleSuccess({ user: { id: target.id, status } });
  });
}
