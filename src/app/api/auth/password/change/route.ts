import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { verifyPassword, hashPassword } from '@/lib/auth/password';
import { strongPasswordSchema } from '@/lib/auth/strength';
import { checkBreached } from '@/lib/auth/breached';
import { updateUser } from '@/lib/db/queries/users';
import { findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { z } from 'zod';

const changeSchema = z.object({
  current_password: z.string().min(1),
  new_password: strongPasswordSchema,
  new_password_confirm: z.string(),
}).refine((data) => data.new_password === data.new_password_confirm, {
  message: 'パスワードが一致しません',
  path: ['new_password_confirm'],
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user, session, body }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }

      const { current_password, new_password } = changeSchema.parse(body);

      const fullUser = await findUserById(user.id);
      if (!fullUser || !(await verifyPassword(current_password, fullUser.passwordHash ?? ''))) {
        return failResponse('INVALID_CREDENTIALS', '認証情報が正しくありません', 401);
      }

      const ipHash = request.headers.get('x-forwarded-for') ?? 'unknown';
      const breachResult = await checkBreached(new_password);
      if (breachResult.breached) {
        return failResponse('VALIDATION_ERROR', 'このパスワードは漏洩している可能性があります', 400);
      }
      if (breachResult.failOpen) {
        await recordSecurityEvent('breach_check_fail_open', null, ipHash, request.headers.get('user-agent') ?? '');
      }

      const passwordHash = await hashPassword(new_password);
      await updateUser(user.id, {
        passwordHash,
        passwordChangedAt: new Date(),
      });

      await revokeAllSessions(user.id, 'password_changed');

      await recordSecurityEvent('password_changed', user.id, ipHash, request.headers.get('user-agent') ?? '');

      await sendChangeNotificationEmail(fullUser.email, {
        change: 'パスワード変更',
        time: new Date().toISOString(),
        ip: ipHash,
      });

      return handleSuccess({ message: 'パスワードを変更しました' });
    },
  );
}