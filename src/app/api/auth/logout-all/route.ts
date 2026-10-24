import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline } from '@/lib/api/utils';
import { revokeAllSessions } from '@/lib/auth/session';
import { getRequestClientIp } from '@/lib/auth/session';
import { clearSessionCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { findUserById } from '@/lib/db/queries/users';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { m } from '@/messages/ja';

/**
 * 全デバイスからログアウト（§8 / §19 / D-30-10）。
 *
 * - 重要操作なので**再認証必須**（5 分猶予・D-14）。`REAUTH_REQUIRED` は 401
 * - 現行セッションも含め全件失効（計画 D-03）
 * - 変更系通知を送るが、**送信失敗で結果を失敗にしない**
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true, denyTotpPending: false },
    async ({ user }) => {
      if (!user) throw new Error('unreachable');

      const ip = getRequestClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? '';

      await revokeAllSessions(user.id, 'logout_all');
      await recordSecurityEvent('session_revoked', user.id, ip, userAgent, { all: true });
      await clearSessionCookie();

      const fullUser = await findUserById(user.id);
      if (fullUser) {
        await deliverEmailSafely({
          kind: 'change_notification',
          userId: user.id,
          ip,
          userAgent,
          send: () =>
            sendChangeNotificationEmail(fullUser.email, {
              change: m('sessions.signOutAll'),
              time: new Date().toISOString(),
              ip,
            }),
        });
      }

      return NextResponse.json(
        { success: true, data: { revoked_all: true, message: m('sessions.signOutAllResult') } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
  );
}