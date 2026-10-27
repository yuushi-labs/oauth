import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { revokeAllSessions, getRequestClientIp } from '@/lib/auth/session';
import { recordAdminAudit } from '@/lib/auth/audit';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/** POST /api/admin/users/{id}/sessions/revoke — 対象の全セッションを失効させる（§11.6 #37）。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    await revokeAllSessions(target.id, 'admin_revoke');
    await recordSecurityEvent('session_revoked', target.id, ip, userAgent, { by: user.id, scope: 'admin' });
    await recordAdminAudit({
      action: 'admin_session_revoked',
      actorUserId: user.id,
      targetUserId: target.id,
      ip,
      userAgent,
    });

    return handleSuccess({ user: { id: target.id }, sessions_revoked: true });
  });
}
