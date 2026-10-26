import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { verifyPasskeyAuthentication } from '@/lib/auth/passkey/authentication';
import { consumeChallenge } from '@/lib/auth/passkey/challenge';
import { advanceSignCount, findCredentialByCredentialId } from '@/lib/db/queries/webauthn';
import { findUserById } from '@/lib/db/queries/users';
import { loginVerifySchema } from '@/lib/validate/passkey';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { createSession, getRequestClientIp } from '@/lib/auth/session';
import { setSessionCookie, setAnonCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { isFirstSessionFromDevice, notifyNewDeviceLogin } from '@/lib/auth/notifications';

/**
 * POST /api/auth/passkey/login/verify — ログイン応答を検証して**新セッション**を発行する（§8.5）。
 *
 * 未認証で呼べる。失敗は列挙耐性のため `INVALID_CODE` に丸め、`user_id` が特定できた場合のみ
 * `login_failed` をそのユーザーに紐づける（§46）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: false }, async ({ body }) => {
    const ip = getRequestClientIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';

    const rl = await rateLimiter.check(
      rateLimitKeys.passkeyIp(ip),
      RATE_LIMITS.passkey.window,
      RATE_LIMITS.passkey.limit,
      RATE_LIMITS.passkey.softLimit,
    );
    if (!rl.allowed) {
      if (rl.logRateLimited) await recordSecurityEvent('rate_limited', null, ip, userAgent, { scope: 'passkey' });
      return rateLimitResponse(rl.resetAt);
    }

    const { response, challenge_id } = loginVerifySchema.parse(body);

    // 1. challenge を 1 回限り消費する（discoverable は user_id を問わない）。
    const consumed = await consumeChallenge({ id: challenge_id, type: 'authentication', userId: null });
    if (!consumed) {
      await recordSecurityEvent('login_failed', null, ip, userAgent, { scope: 'passkey' });
      return failResponse('INVALID_CODE', 'パスキーでログインできませんでした', 400);
    }

    // 2. credential → user を解決する（削除済みユーザーは返らない）。
    const stored = await findCredentialByCredentialId(response.id);
    if (!stored) {
      await recordSecurityEvent('login_failed', null, ip, userAgent, { scope: 'passkey' });
      return failResponse('INVALID_CODE', 'パスキーでログインできませんでした', 400);
    }

    // 3. user の状態を再確認する（停止・削除は同じ 403 にまとめ、どちらの事実か教えない）。
    const user = await findUserById(stored.userId);
    if (!user || user.status !== 'active' || !user.emailVerified || user.deletedAt) {
      await recordSecurityEvent('login_failed', stored.userId, ip, userAgent, { scope: 'passkey' });
      return failResponse('ACCOUNT_SUSPENDED', 'このアカウントは利用できません', 403);
    }

    // 4. 署名・origin・rpID・challenge・sign_count を検証する（失敗は ApiError(INVALID_CODE)）。
    let newCounter: number;
    try {
      const verified = await verifyPasskeyAuthentication({
        // zod は「形」だけを検査する。暗号学的検証はライブラリが行う（D-34-03）。
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: consumed.challenge,
        storedCredential: {
          credentialId: stored.credentialId,
          publicKey: stored.publicKey,
          signCount: stored.signCount,
          transports: stored.transports,
        },
        config: getWebauthnConfig(),
      });
      newCounter = verified.newCounter;
    } catch (error) {
      await recordSecurityEvent('login_failed', stored.userId, ip, userAgent, { scope: 'passkey' });
      throw error;
    }

    // 5. sign_count を atomic に進める（0 行は並行 replay かクローン・D-34-06）。
    const advanced = await advanceSignCount({
      credentialId: stored.credentialId,
      userId: user.id,
      newCounter,
    });
    if (!advanced) {
      await recordSecurityEvent('login_failed', stored.userId, ip, userAgent, { scope: 'passkey' });
      return failResponse('INVALID_CODE', 'パスキーでログインできませんでした', 400);
    }

    // 6. 新セッションを発行する（既存セッションは奪わない・D-34-07）。
    const { token, session } = await createSession(user.id, request);
    await setSessionCookie(token);
    await setAnonCookie(session.csrfSecret);

    // 7. 新規デバイス通知（失敗してもログインは成功として扱う）。
    try {
      const isNewDevice = await isFirstSessionFromDevice(
        user.id,
        session.id,
        session.ipHash,
        session.deviceName,
      );
      if (isNewDevice) {
        await notifyNewDeviceLogin({
          userId: user.id,
          userEmail: user.email,
          deviceName: session.deviceName,
          ipMasked: session.ipMasked,
          ipCountry: null,
          occurredAt: new Date(),
          ip,
          userAgent,
        });
      }
    } catch {
      // 通知判定の失敗でもログインは成功として扱う
    }

    await recordSecurityEvent('login_success', user.id, ip, userAgent, { method: 'passkey' });

    return handleSuccess({ message: 'ログインしました' });
  });
}
