import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline } from '@/lib/api/utils';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { rateLimitResponse } from '@/lib/api/utils';
import { listAccountsByUser } from '@/lib/auth/oauth/accounts';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';

export const dynamic = 'force-dynamic';

/**
 * 自分の連携一覧（§11）。
 *
 * **他人の連携は一切返さない**。owner はセッションから確定し、body やクエリから
 * user_id を受け取らない（IDOR 対策・§49 / P4-C-03）。
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

    const rows = await listAccountsByUser(user.id);
    const labelByProvider = new Map<string, string>(
      OAUTH_PROVIDER_REGISTRY.map((p) => [p.id as string, p.label]),
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          accounts: rows.map((row) => ({
            id: row.id,
            provider: row.provider,
            provider_label: labelByProvider.get(row.provider) ?? row.provider,
            provider_email: row.providerEmail,
            created_at: row.createdAt.toISOString(),
            last_used_at: row.lastUsedAt.toISOString(),
          })),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}