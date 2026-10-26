import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { listCredentialsByUser } from '@/lib/db/queries/webauthn';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * GET /api/auth/passkey — 登録済み Passkey の一覧（§8.1）。
 *
 * `credential_id` / `public_key` は**返さない**（§45）。削除は内部 ID（`wac_`）で行う。
 */
export async function GET(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const rl = await rateLimiter.check(
      rateLimitKeys.settingsUser(user.id),
      RATE_LIMITS.settings.window,
      RATE_LIMITS.settings.limit,
      RATE_LIMITS.settings.softLimit,
    );
    if (!rl.allowed) {
      if (rl.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'passkey' });
      return rateLimitResponse(rl.resetAt);
    }

    const rows = await listCredentialsByUser(user.id);
    return handleSuccess({
      passkeys: rows.map((row) => ({
        id: row.id,
        device_name: row.deviceName,
        created_at: row.createdAt.toISOString(),
        last_used_at: row.lastUsedAt?.toISOString() ?? null,
        backed_up: row.backedUp,
        transports: row.transports,
      })),
    });
  });
}
