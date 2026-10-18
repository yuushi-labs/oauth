import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, handleSuccess } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { ApiError } from '@/lib/errors';
import {
  countAccountsByUser,
  deleteAccount,
  findAccountByIdForUser,
} from '@/lib/auth/oauth/accounts';
import { notifyAccountChange } from '@/lib/auth/notifications';

export const dynamic = 'force-dynamic';

/**
 * 連携の解除（§11 / P4-C-02）。
 *
 * - **再認証必須**（5 分猶予・D-14）。パスワード無しで自分の SNS アカウントを外されたくないため。
 * - owner 確認つきで削除するので、他人の id を渡しても 404 になる（§49）。
 * - **最後の認証手段は解除できない**。`password_hash === null` かつ連携 0 件になると
 *   ログインできなくなるため 409 で拒否する（§7.8 T7）。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuthPipeline(request, { requireAuth: true, requireReauth: true }, async ({ user }) => {
    if (!user) throw new Error('unreachable');
    const { id } = await params;

    const limit = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!limit.allowed) throw new ApiError('RATE_LIMITED');

    const account = await findAccountByIdForUser(id, user.id);
    // 存在しない場合と他人の場合も同じ 404 に落とす（どちらの事実か教えない・§49）。
    if (!account) throw new ApiError('INVALID_TOKEN', '連携が見つかりません', 404);

    const remaining = await countAccountsByUser(user.id);
    if (user.passwordHash === null && remaining <= 1) {
      throw new ApiError('LAST_LOGIN_METHOD');
    }

    await deleteAccount(id, user.id);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';
    await recordSecurityEvent('oauth_unlinked', user.id, ip, userAgent, {
      provider: account.provider,
    });

    // 解除の通知。本文には provider 名と日時だけを入れ、認証フローの値は一切載せない（§45）。
    await notifyAccountChange({
      userId: user.id,
      userEmail: user.email,
      action: 'unlink',
      provider: account.provider,
      ip,
      userAgent,
    });

    return handleSuccess({ message: '連携を解除しました', provider: account.provider });
  });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Method Not Allowed' } }, { status: 405 });
}