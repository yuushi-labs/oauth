/**
 * WebAuthn の challenge を発行し、**1 回限り**で消費する（D-34-05 / D-16）。
 *
 * challenge は `@simplewebauthn/server` の `generateChallenge()` が作る使い捨ての乱数。
 * DB に平文で保存し、消費は `consumeChallengeRow` の**単文 UPDATE の更新行数 = 1** で判定する。
 * read → 判定 → write の 2 段書きにすると、同じ challenge の並行送信が 2 回通る（§48）。
 */
import { generateChallenge, isoBase64URL } from '@simplewebauthn/server/helpers';
import { insertChallenge, consumeChallengeRow } from '@/lib/db/queries/webauthn';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengeType = 'registration' | 'authentication';

/** challenge を発行して DB に保存する。`id` を `challenge_id` としてクライアントへ返す。 */
export async function issueChallenge(args: {
  userId: string | null;
  type: ChallengeType;
}): Promise<{ id: string; challenge: string }> {
  const challenge = isoBase64URL.fromBuffer(await generateChallenge());
  const id = await insertChallenge({
    userId: args.userId,
    type: args.type,
    challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return { id, challenge };
}

/**
 * challenge を 1 回限りで消費し、保存された challenge 文字列を返す。
 * 再利用・期限切れ・type 不一致・他人の challenge はすべて null（区別しない・§46）。
 */
export async function consumeChallenge(args: {
  id: string;
  type: ChallengeType;
  userId: string | null;
}): Promise<{ challenge: string; userId: string | null } | null> {
  return consumeChallengeRow({ id: args.id, type: args.type, userId: args.userId });
}
