import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, rateLimitResponse } from '@/lib/api/utils';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { deriveOsLabel } from '@/lib/util/device';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { resolveTimeZone } from '@/lib/util/datetime';

/**
 * 自分のセッション一覧（§19 / §38）。
 *
 * 返却するのは表示に必要な項目だけ。生 IP・user_agent・session_hash・csrf_secret は
 * 返さない（D-30-08 / §20・§45・§49）。現在セッションの判定もサーバー側で行う。
 */
export async function GET(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user, session }) => {
    if (!user || !session) throw new Error('unreachable');

    const limit = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!limit.allowed) return rateLimitResponse(limit.resetAt);

    const [rows, preferences] = await Promise.all([
      listActiveSessionsByUser(user.id),
      getUserPreferences(user.id),
    ]);

    const sessions = rows
      .map((row) => ({
        id: row.id,
        device_name: row.deviceName ?? 'その他のデバイス',
        os: deriveOsLabel(row.userAgent),
        ip_masked: row.ipMasked ?? null,
        last_seen_at: row.lastSeenAt.toISOString(),
        created_at: row.createdAt.toISOString(),
        current: row.id === session.id,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at));

    return NextResponse.json(
      { success: true, data: { sessions, timezone: resolveTimeZone(preferences.timezone) } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}