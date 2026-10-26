import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { hashPassword } from '@/lib/auth/password';
import { strongPasswordSchema } from '@/lib/auth/strength';
import { checkBreached } from '@/lib/auth/breached';
import { updateUser } from '@/lib/db/queries/users';
import { findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { z } from 'zod';

const resetSchema = z.object({
  token: z.string().min(1),
  password: strongPasswordSchema,
  password_confirm: z.string(),
}).refine((data) => data.password === data.password_confirm, {
  message: 'パスワードが一致しません',
  path: ['password_confirm'],
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { token, password } = resetSchema.parse(body);

      const hash = hashToken(token);
      const result = await verifyAndConsumeToken(hash, 'password_reset');
      if (!result.valid || !result.userId) {
        return failResponse('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています', 400);
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
      await updateUser(result.userId, {
        passwordHash,
        passwordChangedAt: new Date(),
      });

      await revokeAllSessions(result.userId, 'password_reset');

      await recordSecurityEvent('password_reset', result.userId, ip, request.headers.get('user-agent') ?? '');

      const user = await findUserById(result.userId);
      if (user) {
        await deliverEmailSafely({
          kind: 'change_notification',
          userId: result.userId,
          ip,
          userAgent: request.headers.get('user-agent') ?? '',
          send: () =>
            sendChangeNotificationEmail(user.email, {
              change: 'パスワードリセット',
              time: new Date().toISOString(),
              ip,
            }),
        });
      }

      return handleSuccess({ message: 'パスワードがリセットされました' });
    },
  );
}
