import { NextRequest } from 'next/server';
import { withAdminPipeline } from '@/lib/api/admin';
import { handleSuccess } from '@/lib/api/utils';
import { listAdminUsers } from '@/lib/db/queries/admin';
import { listQuerySchema } from '@/lib/validate/admin';
import { recordAdminAudit } from '@/lib/auth/audit';
import { getRequestClientIp } from '@/lib/auth/session';

/**
 * GET /api/admin/users — ユーザー一覧（§11.6 #35 / §51）。
 *
 * **パスワード / TOTP secret / passkey 公開鍵は絶対に返さない**（★）。`has_password` /
 * `has_2fa` / `passkey_count` に畳んで返す。閲覧自体も監査ログに記録する（§61）。
 */
export async function GET(request: NextRequest) {
  return withAdminPipeline(request, 'read', async ({ user }) => {
    const { limit, offset } = listQuerySchema.parse({
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
      offset: request.nextUrl.searchParams.get('offset') ?? undefined,
    });

    const { users, total } = await listAdminUsers({ limit, offset });

    await recordAdminAudit({
      action: 'admin_user_viewed',
      actorUserId: user.id,
      ip: getRequestClientIp(request),
      userAgent: request.headers.get('user-agent') ?? '',
      metadata: { count: users.length },
    });

    return handleSuccess({
      users: users.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        email_verified: row.emailVerified,
        status: row.status,
        role_id: row.roleId,
        created_at: row.createdAt.toISOString(),
        deleted_at: row.deletedAt?.toISOString() ?? null,
        has_password: row.hasPassword,
        has_2fa: row.has2fa,
        passkey_count: row.passkeyCount,
      })),
      total,
    });
  });
}
