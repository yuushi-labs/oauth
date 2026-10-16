import { and, eq, isNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { oidcUserGrants } from '@/lib/db/schema';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { purgeOidcGrantArtifacts } from '@/lib/oidc/grants';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';

const schema = z.object({ grant_id: z.string().min(1).max(256) });

export async function DELETE(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) return failResponse('VALIDATION_ERROR', '取り消す連携を確認できません', 400);

    const db = getDb();
    const [grant] = await db.update(oidcUserGrants)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(oidcUserGrants.id, body.data.grant_id), eq(oidcUserGrants.userId, user.id), isNull(oidcUserGrants.revokedAt)))
      .returning({ id: oidcUserGrants.id, clientId: oidcUserGrants.clientId });
    if (!grant) return failResponse('NOT_FOUND', '有効な連携が見つかりません', 404);

    await purgeOidcGrantArtifacts(grant.id);
    await recordSecurityEvent('oidc_grant_revoked', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '', { clientId: grant.clientId });
    return handleSuccess({ message: 'サービス連携を取り消しました' });
  });
}
