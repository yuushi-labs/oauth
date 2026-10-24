import { ApiError } from '@/lib/errors';
import { checkReauth } from '@/lib/auth/reauth';
import { verifyAndConsumeTotp } from '@/lib/auth/totp';
import { consumeRecoveryCode } from '@/lib/auth/recovery-codes';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

/** 強い再認証で使える手段（Phase 5 は 'password' のみ。Phase 6 が 'passkey' を足す）。 */
export type StrongReauthMethod = 'password' | 'passkey';

/** UI が出し分けに使う。Phase 5 の戻り値は ['password'] 固定（D-33-25）。 */
export function availableStrongReauthMethods(_user: User): StrongReauthMethod[] {
  return ['password'];
}

type StrongReauthVerifier = (args: {
  user: User;
  session: SessionData;
  code: string;
}) => Promise<boolean>;

const TOTP_CODE_PATTERN = /^\d{6}$/;

/**
 * パスワード再認証（既存の 5 分猶予）＋ 現在のコードの 2 要素（D-33-23(A)）。
 * 再認証が未了ならコードを消費せずに `REAUTH_REQUIRED` を投げる（R14）。
 */
const passwordAndCodeVerifier: StrongReauthVerifier = async ({ user, session, code }) => {
  checkReauth(session);
  if (TOTP_CODE_PATTERN.test(code)) {
    const result = await verifyAndConsumeTotp({ userId: user.id, code });
    return result.ok;
  }
  return consumeRecoveryCode(user.id, code);
};

/**
 * Phase 5 は 1 件。Phase 6 は `passkeyVerifier` を足すだけで、API ルートは無変更（D-33-24）。
 */
const verifiers: StrongReauthVerifier[] = [passwordAndCodeVerifier];

/**
 * 強い再認証を要求する。検証器を順に試し、1 つでも通れば成功。
 * 再認証未了は 401 `REAUTH_REQUIRED`、再認証済みでコード誤りは 400 `INVALID_CODE`。
 */
export async function requireStrongReauth(args: {
  user: User;
  session: SessionData;
  code: string;
}): Promise<{ method: StrongReauthMethod }> {
  checkReauth(args.session);
  for (const verify of verifiers) {
    if (await verify(args)) {
      return { method: availableStrongReauthMethods(args.user)[0] ?? 'password' };
    }
  }
  throw new ApiError('INVALID_CODE', '認証コードが正しくありません');
}
