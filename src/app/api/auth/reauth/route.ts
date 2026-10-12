import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { verifyPassword } from '@/lib/auth/password';
import { setReauthVerified } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import { z } from 'zod';

const reauthSchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user, session, body }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }

      const { password } = reauthSchema.parse(body);

      const fullUser = await findUserById(user.id);
      if (!fullUser || !(await verifyPassword(password, fullUser.passwordHash ?? ''))) {
        return failResponse('INVALID_CREDENTIALS', '認証情報が正しくありません', 401);
      }

      await setReauthVerified(session.id);

      return handleSuccess({ message: '再認証完了' });
    },
  );
}