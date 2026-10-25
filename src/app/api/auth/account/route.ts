import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { softDeleteUser } from '@/lib/db/queries/users';
import { findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { invalidateAllUserTokens } from '@/lib/db/queries/tokens';
import { revokeUserOidcGrants } from '@/lib/oidc/grants';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { sendAccountDeletionEmail } from '@/lib/auth/email/templates';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';

export async function DELETE(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user, session }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }

      await softDeleteUser(user.id);
      await revokeAllSessions(user.id, 'account_delete');
      await invalidateAllUserTokens(user.id);
      const revokedClients = await revokeUserOidcGrants(user.id);

      await recordSecurityEvent('account_deleted', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '', { revokedOidcClients: revokedClients.length });

      const fullUser = await findUserById(user.id);
      if (fullUser) {
        await deliverEmailSafely({
          kind: 'account_deletion',
          userId: user.id,
          ip: getRequestClientIp(request),
          userAgent: request.headers.get('user-agent') ?? '',
          send: () => sendAccountDeletionEmail(fullUser.email),
        });
      }

      return handleSuccess({ message: 'アカウントを削除しました' });
    },
  );
}
