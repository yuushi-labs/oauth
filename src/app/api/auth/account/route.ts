import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { softDeleteUser } from '@/lib/db/queries/users';
import { findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { invalidateAllUserTokens } from '@/lib/db/queries/tokens';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { sendAccountDeletionEmail } from '@/lib/auth/email/templates';

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

      await recordSecurityEvent('account_deleted', user.id, request.headers.get('x-forwarded-for') ?? '', request.headers.get('user-agent') ?? '');

      const fullUser = await findUserById(user.id);
      if (fullUser) {
        await sendAccountDeletionEmail(fullUser.email);
      }

      return handleSuccess({ message: 'アカウントを削除しました' });
    },
  );
}