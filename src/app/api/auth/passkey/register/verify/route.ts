import { NextRequest } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess, rateLimitResponse } from '@/lib/api/utils';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { verifyPasskeyRegistration } from '@/lib/auth/passkey/registration';
import { consumeChallenge } from '@/lib/auth/passkey/challenge';
import { insertCredential } from '@/lib/db/queries/webauthn';
import { registerVerifySchema } from '@/lib/validate/passkey';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { getRequestClientIp } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { sendChangeNotificationEmail } from '@/lib/auth/email/templates';
import { findUserById } from '@/lib/db/queries/users';
import { deriveDeviceName, MAX_DEVICE_NAME } from '@/lib/util/device';
import { m } from '@/messages/ja';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * PostgreSQL の unique 制約違反（SQLSTATE 23505）か。drizzle は driver のエラーを
 * `DrizzleQueryError` で包むため、`cause` を辿って判定する。
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `device_name` を切り詰め・制御文字除去する（D-34-10）。未指定なら UA から導出する。 */
function resolveDeviceName(raw: string | undefined, userAgent: string): string {
  if (raw) {
    const cleaned = raw.replace(CONTROL_CHARS, '').trim().slice(0, MAX_DEVICE_NAME);
    if (cleaned) return cleaned;
  }
  return deriveDeviceName(userAgent);
}

/**
 * POST /api/auth/passkey/register/verify — 登録応答を検証して保存する（§8.3）。
 *
 * 手順: challenge を 1 回限り消費 → 署名検証 → 公開鍵のみ保存 → `passkey_added` 記録 → 通知。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true, requireReauth: true },
    async ({ user, body }) => {
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

      const { response, challenge_id, device_name } = registerVerifySchema.parse(body);

      // 1. challenge を先に 1 回限り消費する（検証失敗でも消費済みのまま＝再送不可・R11）。
      const consumed = await consumeChallenge({
        id: challenge_id,
        type: 'registration',
        userId: user.id,
      });
      if (!consumed) return failResponse('INVALID_CODE', 'パスキーの登録を検証できませんでした', 400);

      // 2. 署名・origin・rpID・challenge を検証する（失敗は ApiError(INVALID_CODE)）。
      const verified = await verifyPasskeyRegistration({
        // zod は「形」だけを検査する。暗号学的検証はライブラリが行う（D-34-03）。
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: consumed.challenge,
        config: getWebauthnConfig(),
      });

      // 3. 公開鍵のみを保存する（秘密鍵はサーバに来ない・§12）。
      //    同一 credential の二重登録は unique 制約違反（23505）になるため 409 に丸める。
      let row;
      try {
        row = await insertCredential({
          userId: user.id,
          credentialId: verified.credentialId,
          publicKey: verified.publicKey,
          signCount: verified.signCount,
          transports: verified.transports,
          aaguid: verified.aaguid,
          deviceName: resolveDeviceName(device_name, userAgent),
          backedUp: verified.backedUp,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return failResponse('CREDENTIAL_ALREADY_REGISTERED', 'このパスキーは既に登録されています', 409);
        }
        throw error;
      }

      await recordSecurityEvent('passkey_added', user.id, ip, userAgent, { device_name: row.deviceName });

      const fullUser = await findUserById(user.id);
      if (fullUser) {
        await deliverEmailSafely({
          kind: 'passkey_change',
          userId: user.id,
          ip,
          userAgent,
          send: () =>
            sendChangeNotificationEmail(fullUser.email, {
              change: m('passkey.title'),
              time: new Date().toISOString(),
              ip,
            }),
        });
      }

      return handleSuccess({
        passkey: {
          id: row.id,
          device_name: row.deviceName,
          created_at: row.createdAt.toISOString(),
        },
      });
    },
  );
}
