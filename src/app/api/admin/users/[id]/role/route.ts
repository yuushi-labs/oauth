import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { resolveAdminTarget } from '@/lib/api/admin-target';
import { applyRoleChange } from '@/lib/auth/admin-role';
import { roleChangeSchema } from '@/lib/validate/admin';
import { getRequestClientIp } from '@/lib/auth/session';
import { ROLE_IDS } from '@/lib/db/schema';
import { roleRank } from '@/lib/auth/admin-policy';

/**
 * POST /api/admin/users/{id}/role — role を変更する（Phase 7.5 / §50 / §51）。
 *
 * 付与できるのは rank ≤ `admin` まで（D-36-01）。自分自身は対象外（D-36-02）、
 * 最後の有効な管理者の降格は 409 `LAST_ADMIN`（D-36-03）。セッションは失効させない（D-36-04）。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAdminPipeline(request, 'mutation', async ({ user, body }) => {
    const { id } = await context.params;
    const target = await resolveAdminTarget(id, user);

    const { role_id: roleId } = roleChangeSchema.parse(body);

    await applyRoleChange({
      target,
      roleId,
      maxRank: roleRank(ROLE_IDS.admin),
      actorUserId: user.id,
      ip: getRequestClientIp(request),
      userAgent: request.headers.get('user-agent') ?? '',
    });

    return handleSuccess({ user: { id: target.id, role_id: roleId } });
  });
}
