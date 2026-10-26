import { NextRequest } from 'next/server';
import { withAuthPipeline, handleSuccess, failResponse } from '@/lib/api/utils';
import { findTotpByUserId } from '@/lib/db/queries/totp';
import { countUnusedRecoveryCodes } from '@/lib/auth/recovery-codes';
import { availableStrongReauthMethods } from '@/lib/auth/strong-reauth';

/** GET /api/auth/2fa — 2FA の状態（有効/無効・残数・強い再認証の手段）。 */
export async function GET(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const row = await findTotpByUserId(user.id);
    const enabled = Boolean(row?.enabled);
    const remaining = enabled ? await countUnusedRecoveryCodes(user.id) : 0;

    return handleSuccess({
      enabled,
      recovery_codes_remaining: remaining,
      strong_reauth_methods: await availableStrongReauthMethods(user),
    });
  });
}
