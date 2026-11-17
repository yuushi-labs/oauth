import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { oauthStates } from '@/lib/db/schema';
import { randomToken, sha256Hex } from '@/lib/util/crypto';
import { redirectUriFor } from './redirect-uri';
import { normalizeRedirectTo } from './safe-redirect';
import type { OAuthIntent, OAuthProviderId } from './types';

// 既存の import 元（テスト含む）を壊さないよう、従来どおりここからも公開する。
export { isSafeRedirectPath, normalizeRedirectTo, safeRedirectPath } from './safe-redirect';

/**
 * OAuth 認可リクエストの状態（§12.2 / D-31-05）。
 *
 * **なぜ PostgreSQL なのか**: Redis は任意依存（D-05）で、ブラウザ Cookie に状態を置く設計は
 * 「利用者が Cookie を消すと失敗する」「別タブで上書きされる」等问题が出る。PostgreSQL が
 * 既に正本なので、1 回限りの消費を **DB 側の UPDATE で強制する**方針にした。
 */

/** 認可リクエストの TTL。10 分（計画 12.1）。 */
const TTL_SECONDS = 10 * 60;

/** PKCE の code_verifier は 43〜128 文字。base64url(32B) = 43 文字で下限を満たす。 */
function randomSecret(): string {
  return randomToken(32);
}

const hashState = (state: string): string => sha256Hex(state);

export type IssuedState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
};

export type ConsumedState = {
  nonce: string;
  codeVerifier: string;
  intent: OAuthIntent;
  userId: string | null;
  redirectTo: string | null;
};

export async function issueOAuthState(args: {
  provider: OAuthProviderId;
  intent: OAuthIntent;
  /** link のときのみ設定する（login は null） */
  userId?: string | null;
  redirectTo?: string | null;
}): Promise<IssuedState> {
  const state = randomSecret();
  const nonce = randomSecret();
  const codeVerifier = randomSecret();

  await getDb().insert(oauthStates).values({
    stateHash: hashState(state),
    provider: args.provider,
    intent: args.intent,
    userId: args.userId ?? null,
    nonce,
    codeVerifier,
    redirectTo: normalizeRedirectTo(args.redirectTo),
    expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
  });

  return { state, nonce, codeVerifier, redirectUri: redirectUriFor(args.provider) };
}

/**
 * state を**消費する**。返り値が null なら失敗（= 不一致 / 期限切れ / 消費済みのいずれか）。
 *
 * `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` にすることで、2 回目以降は必ず
 * 0 行更新＝null になり、認可コードの再利用（replay）が DB 側で 1 回限りとして封じられる。
 * 行数は 0 か 1 しかないので、タイミングを揃えるための定数時間比較は不要。
 *
 * provider も条件に含めることで、Google の state を GitHub の callback に流使えないようにする。
 */
export async function consumeOAuthState(
  state: string,
  provider: OAuthProviderId,
): Promise<ConsumedState | null> {
  const rows = await getDb()
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthStates.stateHash, hashState(state)),
        eq(oauthStates.provider, provider),
        gt(oauthStates.expiresAt, new Date()),
        isNull(oauthStates.consumedAt),
      ),
    )
    .returning();

  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    nonce: row.nonce,
    codeVerifier: row.codeVerifier,
    intent: row.intent as OAuthIntent,
    userId: row.userId ?? null,
    // 保存時に正規化済みだが、正規化が入る前に書かれた行や手動更新に備えて読み出しでも通す
    // （open redirect 対策を 1 か所の判断に依存させない）。
    redirectTo: normalizeRedirectTo(row.redirectTo),
  };
}

/** PKCE の code_challenge は S256 固定（plain は許さない）。 */
export function codeChallengeFor(codeVerifier: string): string {
  return Buffer.from(sha256Hex(codeVerifier), 'hex').toString('base64url');
}