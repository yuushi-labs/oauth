import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { softDeleteUser } from '@/lib/db/queries/users';
import { revokeAllSessions, getRequestClientIp } from '@/lib/auth/session';
import { invalidateAllUserTokens } from '@/lib/db/queries/tokens';
import { revokeUserOidcGrants } from '@/lib/oidc/grants';
import { recordAdminAudit } from '@/lib/auth/audit';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * POST /api/admin/users/{id}/delete — ユーザーを論理削除する（§11.6）。
 *
 * 論理削除（`deleted_at`）＋ 全セッション・全トークン・OIDC grant の失効。自己削除は禁止（D-35-10）。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    await softDeleteUser(target.id);
    await revokeAllSessions(target.id, 'admin_delete');
    await invalidateAllUserTokens(target.id);
    const revokedClients = await revokeUserOidcGrants(target.id);

    await recordSecurityEvent('account_deleted', target.id, ip, userAgent, {
      by: user.id,
      revokedOidcClients: revokedClients.length,
    });
    await recordAdminAudit({
      action: 'admin_account_deleted',
      actorUserId: user.id,
      actorUsername: user.username,
      targetUserId: target.id,
      targetUsername: target.username,
      ip,
      userAgent,
      metadata: { status: 'deleted' },
    });

    return handleSuccess({ user: { id: target.id, status: 'deleted' } });
  });
}
