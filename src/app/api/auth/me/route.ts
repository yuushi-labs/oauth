import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { findUserById } from '@/lib/db/queries/users';

export async function GET(request: NextRequest) {
  return withAuthPipeline(
    request,
    // 画面が「保留中」を判定するために読む（secret を返さない・§9.4）。
    { requireAuth: false, denyTotpPending: false },
    async ({ user, session }) => {
      if (!session || !user) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      const fullUser = await findUserById(user.id);
      if (!fullUser) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      return handleSuccess({
        id: fullUser.id,
        username: fullUser.username,
        email: fullUser.email,
        email_verified: fullUser.emailVerified,
        status: fullUser.status,
      });
    },
  );
}