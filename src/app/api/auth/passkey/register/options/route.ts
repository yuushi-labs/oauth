import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { generatePasskeyRegistrationOptions } from '@/lib/auth/passkey/registration';
import { issueChallenge } from '@/lib/auth/passkey/challenge';
import { listCredentialsByUser } from '@/lib/db/queries/webauthn';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';

/**
 * POST /api/auth/passkey/register/options — 登録 options を発行する（§8.2）。
 *
 * **再認証必須**（D-34-08）＋ **email 確認済み・active のみ**（D-34-02）。
 * 既存 credential を `excludeCredentials` に入れて二重登録を防ぐ。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user }) => {
      if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

      const ip = getRequestClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? '';

      const rl = await rateLimiter.check(
        rateLimitKeys.passkeyIp(ip),
        RATE_LIMITS.passkey.window,
        RATE_LIMITS.passkey.limit,
        RATE_LIMITS.passkey.softLimit,
      );
      if (!rl.allowed) {
        if (rl.logRateLimited) await recordSecurityEvent('rate_limited', user.id, ip, userAgent, { scope: 'passkey' });
        return rateLimitResponse(rl.resetAt);
      }

      // 未確認 email は Passkey を登録できない（D-34-02）。
      if (!user.emailVerified || user.status !== 'active') {
        return failResponse('EMAIL_NOT_VERIFIED', 'メールアドレスの確認が必要です', 403);
      }

      const config = getWebauthnConfig();
      const existing = await listCredentialsByUser(user.id);
      // challenge を先に DB に保存し、**同じ値**を options に埋め込む（§8.3 の challenge 特定方式）。
      const { id: challengeId, challenge } = await issueChallenge({
        userId: user.id,
        type: 'registration',
      });
      const options = await generatePasskeyRegistrationOptions({
        user: { id: user.id, username: user.username, displayName: user.username },
        existingCredentialIds: existing.map((row) => row.credentialId),
        config,
        challenge,
      });

      return handleSuccess({ options, challenge_id: challengeId });
    },
  );
}
