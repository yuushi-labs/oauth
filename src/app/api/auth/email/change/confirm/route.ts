import { NextRequest, NextResponse } from 'next/server';
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
 * BUG-2: the confirmation mail points at this endpoint, and mail clients open links with
 * GET. Previously only POST existed, so every confirmation link returned 405. This GET
 * stays non-mutating (§25) and forwards the user to the screen that performs the POST,
 * exactly like /api/auth/verify-email does.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const destination = new URL('/email-change/confirm', request.url);
  if (token) destination.searchParams.set('token', token);
  return NextResponse.redirect(destination, 303);
}

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
