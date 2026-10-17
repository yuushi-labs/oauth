import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, failResponse } from '@/lib/api/utils';
import { findOwnedActiveSession } from '@/lib/db/queries/sessions';
import { revokeSession, getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { clearSessionCookie } from '@/lib/auth/cookie';

/**
 * セッションの個別失効（§19 / §49）。
 *
 * - 所有者をサーバー側で確認する。他人の ID は**見つからないものとして 404**（IDOR 対策・M2.6 と同じ方針）
 * - GET では状態変更しない（§25）。失効は DELETE のみ
 * - 現在のセッションを消した場合は Cookie も削除する
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session }) => {
    if (!user || !session) throw new Error('unreachable');

    const target = await findOwnedActiveSession(id, user.id);
    if (!target) {
      return failResponse('NOT_FOUND', 'セッションが見つかりません', 404);
    }

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    await revokeSession(target.id, 'logout');
    await recordSecurityEvent('session_revoked', user.id, ip, userAgent, { self: target.id === session.id });

    const wasCurrent = target.id === session.id;
    if (wasCurrent) {
      await clearSessionCookie();
    }

    return NextResponse.json(
      { success: true, data: { revoked: true, was_current: wasCurrent } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}