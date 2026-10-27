import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, rateLimitResponse, type PipelineContext } from '@/lib/api/utils';
import { requireAdminAccess } from '@/lib/auth/admin-policy';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';

export type AdminContext = PipelineContext & { user: NonNullable<PipelineContext['user']> };

/**
 * 管理 API の共通ラッパー（§49 / §51）。
 *
 * 1. `withAuthPipeline`（Origin → CSRF → session → user）
 * 2. `requireReauth`（§51 再認証・GET を含む）
 * 3. `requireAdminAccess`（role ≥ admin ＋ 2FA 有効）
 * 4. レート制限（read / mutation）
 *
 * 認可は**サーバー側のみ**で判定する（§49）。ハンドラは user が保証された状態で受け取る。
 */
export async function withAdminPipeline(
  request: NextRequest,
  scope: 'read' | 'mutation',
  handler: (ctx: AdminContext) => Promise<Response>,
): Promise<Response> {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async (ctx) => {
      if (!ctx.user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

      await requireAdminAccess(ctx.user);

      const limit = scope === 'read' ? RATE_LIMITS.admin.read : RATE_LIMITS.admin.mutation;
      const rl = await rateLimiter.check(
        rateLimitKeys.adminUser(ctx.user.id),
        limit.window,
        limit.limit,
        limit.softLimit,
      );
      if (!rl.allowed) return rateLimitResponse(rl.resetAt);

      return handler(ctx as AdminContext);
    },
  );
}
