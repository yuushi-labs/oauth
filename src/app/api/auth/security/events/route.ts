import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, rateLimitResponse } from '@/lib/api/utils';
import { listRecentSecurityEventsByUser } from '@/lib/db/queries/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * 本人のセキュリティイベント一覧（§21 / §37 / D-30-15）。
 * 読み取り専用 GET。行は追加しない（§25）。生 IP と user_agent は返さない。
 */
export async function GET(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) throw new Error('unreachable');

    const limit = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!limit.allowed) return rateLimitResponse(limit.resetAt);

    const rows = await listRecentSecurityEventsByUser(
      user.id,
      parseLimit(request.nextUrl.searchParams.get('limit')),
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          events: rows.map((row) => ({
            event_type: row.eventType,
            ip_masked: row.ipMasked,
            created_at: row.createdAt.toISOString(),
            metadata: row.metadata,
          })),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}