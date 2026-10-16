import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { updateUser, findUserById } from '@/lib/db/queries/users';
import { markEmailChangeNotified } from '@/lib/db/queries/tokens';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const confirmSchema = z.object({
  token: z.string().min(1),
});

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { token } = confirmSchema.parse(body);

      const hash = hashToken(token);
      const result = await verifyAndConsumeToken(hash, 'email_change');
      if (!result.valid || !result.userId || !result.newEmail) {
        return failResponse('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています', 400);
      }

      const userId = result.userId;
      const newEmail = result.newEmail;

      const db = getDb();
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ email: newEmail, emailVerified: true, updatedAt: new Date() })
          .where(eq(users.id, userId));
      });

      await recordSecurityEvent(
        'email_changed',
        userId,
        getRequestClientIp(request),
        request.headers.get('user-agent') ?? '',
      );

      // 旧メールアドレスへ通知送信
      const user = await findUserById(userId);
      if (user && user.email !== newEmail) {
        try {
          await sendChangeNotificationEmail(user.email, {
            change: 'メールアドレス変更',
            time: new Date().toISOString(),
            ip: getRequestClientIp(request),
          });
          await markEmailChangeNotified(hash);
        } catch {
          // 通知失敗時もメール変更は確定済み、ログのみ記録
          await recordSecurityEvent(
            'email_change_notification_failed',
            userId,
            getRequestClientIp(request),
            request.headers.get('user-agent') ?? '',
            { oldEmail: user.email },
          );
        }
      }

      return handleSuccess({ message: 'email を変更しました' });
    },
  );
}
