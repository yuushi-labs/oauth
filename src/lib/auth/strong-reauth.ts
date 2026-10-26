import { ApiError } from '@/lib/errors';
import { checkReauth } from '@/lib/auth/reauth';
import { verifyAndConsumeTotp } from '@/lib/auth/totp';
import { consumeRecoveryCode } from '@/lib/auth/recovery-codes';
import { getWebauthnConfig } from '@/lib/auth/passkey/config';
import { consumeChallenge } from '@/lib/auth/passkey/challenge';
import { verifyPasskeyAuthentication } from '@/lib/auth/passkey/authentication';
import {
  advanceSignCount,
  countCredentialsByUser,
  findCredentialByCredentialId,
} from '@/lib/db/queries/webauthn';
import { authenticationResponseSchema } from '@/lib/validate/passkey';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

/** 強い再認証で使える手段。Phase 5 は 'password'、Phase 6 が 'passkey' を足す。 */
export type StrongReauthMethod = 'password' | 'passkey';

/**
 * UI が出し分けに使う。Passkey を 1 件以上持つなら `['password', 'passkey']`。
 * DB を引くため非同期（D-34-11）。
 */
export async function availableStrongReauthMethods(user: User): Promise<StrongReauthMethod[]> {
  const count = await countCredentialsByUser(user.id);
  return count > 0 ? ['password', 'passkey'] : ['password'];
}

/** 検証成功なら使用した手段を返す。該当しない/失敗は null。 */
export type StrongReauthVerifier = (args: {
  user: User;
  session: SessionData;
  body: unknown;
}) => Promise<StrongReauthMethod | null>;

const TOTP_CODE_PATTERN = /^\d{6}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readCode(body: unknown): string | null {
  const record = asRecord(body);
  const code = record?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readChallengeId(body: unknown): string | null {
  const record = asRecord(body);
  const challengeId = record?.challenge_id;
  return typeof challengeId === 'string' && challengeId.length > 0 ? challengeId : null;
}

function readPasskeyAssertion(body: unknown): AuthenticationResponseJSON | null {
  const record = asRecord(body);
  if (!record || record.passkey === undefined) return null;
  const parsed = authenticationResponseSchema.safeParse(record.passkey);
  return parsed.success ? (parsed.data as AuthenticationResponseJSON) : null;
}

/**
 * パスワード再認証（5 分猶予）＋ 現在のコード（TOTP またはリカバリーコード）。
 * `body.code` が無ければ**この検証器は該当しない**（null）として Passkey 検証器へ委ねる。
 * コードはあるが再認証が未了なら `checkReauth` が `REAUTH_REQUIRED` を投げる（R14）。
 */
const passwordAndCodeVerifier: StrongReauthVerifier = async ({ user, session, body }) => {
  const code = readCode(body);
  if (!code) return null;
  checkReauth(session);
  const ok = TOTP_CODE_PATTERN.test(code)
    ? (await verifyAndConsumeTotp({ userId: user.id, code })).ok
    : await consumeRecoveryCode(user.id, code);
  return ok ? 'password' : null;
};

/**
 * 再認証用 Passkey assertion を検証する（D-34-11）。
 *
 * `reauth/passkey/options` が `user_id` 付きで発行した challenge を 1 回限り消費し、
 * 自分の credential であることを確認してから署名を検証する。成功したら `sign_count` を
 * atomic に進める。**パスワードの 5 分猶予は要求しない**（Passkey 自体が本人確認）。
 */
const passkeyVerifier: StrongReauthVerifier = async ({ user, body }) => {
  const response = readPasskeyAssertion(body);
  const challengeId = readChallengeId(body);
  if (!response || !challengeId) return null;

  const stored = await findCredentialByCredentialId(response.id);
  if (!stored || stored.userId !== user.id) return null;

  const consumed = await consumeChallenge({ id: challengeId, type: 'authentication', userId: user.id });
  if (!consumed) return null;

  const { newCounter } = await verifyPasskeyAuthentication({
    response,
    expectedChallenge: consumed.challenge,
    storedCredential: {
      credentialId: stored.credentialId,
      publicKey: stored.publicKey,
      signCount: stored.signCount,
      transports: stored.transports,
    },
    config: getWebauthnConfig(),
  });
  const advanced = await advanceSignCount({
    credentialId: stored.credentialId,
    userId: user.id,
    newCounter,
  });
  return advanced ? 'passkey' : null;
};

/**
 * 検証器の配列（D-33-24 / D-34-11）。判定順は「パスワード＋コード → Passkey」。
 * どれか 1 つ通れば成功。
 */
export const strongReauthVerifiers: readonly StrongReauthVerifier[] = [
  passwordAndCodeVerifier,
  passkeyVerifier,
];

/**
 * 強い再認証を要求する。検証器を順に試し、1 つでも通れば成功。
 *
 * 失敗時の扱い（Phase 5 と同じ使い分けを維持する）:
 * - 再認証（パスワードの 5 分猶予）が未了 → 401 `REAUTH_REQUIRED`（UI がパスワード欄を出す）
 * - 再認証済みでコード／assertion が誤り → 400 `INVALID_CODE`
 */
export async function requireStrongReauth(
  args: { user: User; session: SessionData; body: unknown },
  verifiers: readonly StrongReauthVerifier[] = strongReauthVerifiers,
): Promise<{ method: StrongReauthMethod }> {
  for (const verify of verifiers) {
    const method = await verify(args);
    if (method) return { method };
  }
  if (!args.session.reauthVerifiedAt) {
    throw new ApiError('REAUTH_REQUIRED', '本人確認が必要です');
  }
  throw new ApiError('INVALID_CODE', '認証コードが正しくありません');
}
