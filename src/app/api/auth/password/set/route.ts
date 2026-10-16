import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashPassword } from '@/lib/auth/password';
import { strongPasswordSchema } from '@/lib/auth/strength';
import { checkBreached } from '@/lib/auth/breached';
import { updateUser } from '@/lib/db/queries/users';
import { findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { z } from 'zod';

const setSchema = z.object({
  password: strongPasswordSchema,
  password_confirm: z.string(),
}).refine((data) => data.password === data.password_confirm, {
  message: 'パスワードが一致しません',
  path: ['password_confirm'],
});

export async function PUT(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user, session, body }) => {
      if (!user || !session) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }

      const { password } = setSchema.parse(body);

      const fullUser = await findUserById(user.id);
      if (!fullUser) {
        return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);
      }
      if (fullUser.passwordHash) {
        return failResponse('VALIDATION_ERROR', 'パスワードは既に設定されています', 400);
      }
      if (!fullUser.emailVerified) {
        return failResponse('VALIDATION_ERROR', 'email を認証してください', 400);
      }

      const ip = getRequestClientIp(request);
      const breachResult = await checkBreached(password);
      if (breachResult.breached) {
        return failResponse('VALIDATION_ERROR', 'このパスワードは漏洩している可能性があります', 400);
      }
      if (breachResult.failOpen) {
        await recordSecurityEvent('breach_check_fail_open', null, ip, request.headers.get('user-agent') ?? '');
      }

      const passwordHash = await hashPassword(password);
      await updateUser(user.id, {
        passwordHash,
        passwordChangedAt: new Date(),
      });

      await revokeAllSessions(user.id, 'password_changed');

      await recordSecurityEvent('password_changed', user.id, ip, request.headers.get('user-agent') ?? '');

      await sendChangeNotificationEmail(fullUser.email, {
        change: 'パスワード設定',
        time: new Date().toISOString(),
        ip,
      });

      return handleSuccess({ message: 'パスワードを設定しました' });
    },
  );
}
