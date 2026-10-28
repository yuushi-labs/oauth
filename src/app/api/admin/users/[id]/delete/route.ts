import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordAdminAudit } from '@/lib/auth/audit';
import { performAccountDeletion } from '@/lib/auth/account-deletion';

/**
 * POST /api/admin/users/{id}/delete — ユーザーを論理削除する（§11.6）。
 *
 * 論理削除（`deleted_at`）＋ 全セッション・全トークン・Passkey・OIDC grant の失効。
 * 副作用は利用者自身の削除と同じ `performAccountDeletion` に集約する（§24）。
 * 自己削除は禁止（D-35-10）。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    await performAccountDeletion({ userId: target.id, ip, userAgent, metadata: { by: user.id } });

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
