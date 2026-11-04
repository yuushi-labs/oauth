import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { findUserById, findUserByLowerEmail } from '@/lib/db/queries/users';
import { markEmailChangeNotified, findEmailChangeRequestByHash } from '@/lib/db/queries/tokens';
import { isUniqueViolation } from '@/lib/db/sql-state';
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

/**
 * メールアドレス変更の確定（内部実装・残置・D-40-05）。メール送受信の廃止に伴い画面と
 * GET 転送は撤去したが、トークン消費・衝突検査・通知のロジックは将来の復旧用に残す。
 * 現在は UI からの導線が無い。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { token } = confirmSchema.parse(body);

      const hash = hashToken(token);

      // §14: the target address must not already belong to another account. Checked before the
      // token is consumed so a collision does not burn the one-time token, and so the unique
      // index violation cannot surface as a 500. The atomic consume below still closes the race.
      const pending = await findEmailChangeRequestByHash(hash);
      if (pending && pending.purpose === 'email_change' && !pending.usedAt && pending.expiresAt > new Date()) {
        const owner = await findUserByLowerEmail(pending.newEmail);
        if (owner && owner.id !== pending.userId) {
          return failResponse('EMAIL_CONFLICT', 'このメールアドレスは別のアカウントに登録済みです', 409);
        }
      }

      const result = await verifyAndConsumeToken(hash, 'email_change');
      if (!result.valid || !result.userId || !result.newEmail) {
        return failResponse('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています', 400);
      }

      const userId = result.userId;
      const newEmail = result.newEmail;

      // §14 step 6 の通知先は**旧アドレス**。`users.email` を先に更新してから読み直すと
      // 常に新アドレスが返り、通知が送られないまま変更だけが確定してしまう。
      const user = await findUserById(userId);
      const oldEmail = user?.email ?? null;

      const db = getDb();
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ email: newEmail, emailVerified: true, updatedAt: new Date() })
            .where(eq(users.id, userId));
        });
      } catch (error) {
        // 並行して同じアドレスが確定した場合の保険（unique index 違反）。
        if (isUniqueViolation(error)) {
          return failResponse('EMAIL_CONFLICT', 'このメールアドレスは別のアカウントに登録済みです', 409);
        }
        throw error;
      }

      await recordSecurityEvent(
        'email_changed',
        userId,
        getRequestClientIp(request),
        request.headers.get('user-agent') ?? '',
      );

      // 旧メールアドレスへ通知送信
      if (oldEmail && oldEmail !== newEmail) {
        try {
          await sendChangeNotificationEmail(oldEmail, {
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
            { oldEmail },
          );
        }
      }

      return handleSuccess({ message: 'email を変更しました' });
    },
  );
}
