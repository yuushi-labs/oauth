import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { oauthSocialClaims } from '@/lib/db/schema';
import { randomToken, sha256Hex } from '@/lib/util/crypto';
import type { Identity, OAuthProviderId } from './types';

/**
 * ソーシャル連携の確認待ち（Phase 4-B / D-32-05〜D-32-08）。
 *
 * callback の時点で「紐付きが無い」と分かったとき。利用者はここで
 * 「この email でアカウントを作る」または「password でログインして連携する」を選ぶ。
 *
 * - **生の token は DB に保存しない**。Cookie には生 token、DB には SHA-256（D-32-05）。
 * - **消費は UPDATE**。2 回目以降は 0 行更新＝null になるので使い切りになる（D-32-06）。
 * - `emailOwnerId` は**発行時点で確定**する（D-32-07）。完了時に email を引き直すと
 *   発行と完了の間に所有者が変わった場合に判定が揺れるため。
 */

/** 10 分。`oauth_states` と同じ。 */
const TTL_SECONDS = 10 * 60;

export type IssuedSocialClaim = {
  token: string;
  expiresAt: Date;
};

export type SocialClaim = {
  provider: OAuthProviderId;
  providerAccountId: string;
  providerEmail: string | null;
  emailVerified: boolean;
  emailOwnerId: string | null;
};

const hashToken = (token: string): string => sha256Hex(token);

export async function issueSocialClaim(args: {
  provider: OAuthProviderId;
  identity: Identity;
  emailOwnerId: string | null;
}): Promise<IssuedSocialClaim> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

  await getDb().insert(oauthSocialClaims).values({
    stateHash: hashToken(token),
    provider: args.provider,
    providerAccountId: args.identity.providerAccountId,
    providerEmail: args.identity.email,
    emailVerified: args.identity.emailVerified,
    emailOwnerId: args.emailOwnerId,
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * claim を消費する。返り値が null なら失敗（= 不正な token / 期限切れ / 消費済みのいずれか）。
 *
 * provider も条件に含めることで、GitHub の claim を Google の完了リクエストに
 * 流用できないようにする。
 */
export async function consumeSocialClaim(
  token: string,
  provider: OAuthProviderId,
): Promise<SocialClaim | null> {
  const rows = await getDb()
    .update(oauthSocialClaims)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthSocialClaims.stateHash, hashToken(token)),
        eq(oauthSocialClaims.provider, provider),
        gt(oauthSocialClaims.expiresAt, new Date()),
        isNull(oauthSocialClaims.consumedAt),
      ),
    )
    .returning();

  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    provider: row.provider as OAuthProviderId,
    providerAccountId: row.providerAccountId,
    providerEmail: row.providerEmail ?? null,
    emailVerified: row.emailVerified,
    emailOwnerId: row.emailOwnerId ?? null,
  };
}

/** 画面表示用に、まだ消費していない claim を読む（消費はしない）。 */
export async function peekSocialClaim(
  token: string,
  provider: OAuthProviderId,
): Promise<SocialClaim | null> {
  const [row] = await getDb()
    .select()
    .from(oauthSocialClaims)
    .where(
      and(
        eq(oauthSocialClaims.stateHash, hashToken(token)),
        eq(oauthSocialClaims.provider, provider),
        gt(oauthSocialClaims.expiresAt, new Date()),
        isNull(oauthSocialClaims.consumedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    provider: row.provider as OAuthProviderId,
    providerAccountId: row.providerAccountId,
    providerEmail: row.providerEmail ?? null,
    emailVerified: row.emailVerified,
    emailOwnerId: row.emailOwnerId ?? null,
  };
}