/**
 * ソーシャルログイン provider の型（計画 P4-A-01 / D-31-xx）。
 *
 * Phase 3 の registry は「表示に必要なメタデータ」しか持たなかったため、token 交換や
 * identity 取得の関数を差し込む口が無かった。Phase 4 で 型を全面再設計し、
 * **provider ごとの検証ロジックを registry のエントリに持たせる**。
 *
 * ここには秘密値を書いてはいけない。client_id / client_secret は実行時に
 * `envKeys` が指す環境変数から読む（§62）。
 */
export type OAuthProviderId = 'google' | 'github' | 'discord';

/** 認可の意図。login と link は判定ルールが別なので state に載せて callback で分岐する（D-31-15）。 */
export type OAuthIntent = 'login' | 'link';

export type TokenSet = {
  accessToken: string;
  /** OIDC provider（Google）のみ。OAuth2 provider では undefined。 */
  idToken?: string;
  tokenType: string;
  scope?: string;
};

export type Identity = {
  /** provider ごとに独立した外部 ID。数値 ID も必ず文字列で保存する（D-31-10）。 */
  providerAccountId: string;
  /** null は「provider が返さなかった」。空文字扱いにしない（D-31-08）。 */
  email: string | null;
  emailVerified: boolean;
  displayName?: string | null;
};

export type ExchangeCodeArgs = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

export type FetchIdentityArgs = {
  accessToken: string;
  /** OIDC provider の検証済み claims（fetchIdentity がトークンを再検証せずに済む）。 */
  idTokenClaims?: Record<string, unknown>;
};

export type OAuthProviderEntry = {
  id: OAuthProviderId;
  /** ボタンに表示する表示名 */
  label: string;
  /** OIDC provider は nonce / 署名検証が要る。OAuth2 provider は access_token で十分。 */
  protocol: 'oidc' | 'oauth2';
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** 要求する scope（最小権限・D-06。offline_access は求めない） */
  scope: string;
  /** client_id / client_secret の環境変数名。値ではなく「どこにあるか」だけを持つ。 */
  envKeys: { clientId: string; clientSecret: string };
  /**
   * UI にボタンを出すか。client_id と client_secret の**両方**が揃って true（D-31-07）。
   * 片方だけの設定で 500 になるのを防ぐ。
   */
  isConfigured: (env: Record<string, string | undefined>) => boolean;
  /** 認可コード → トークン。code_verifier（PKCE）を必ず送る。 */
  exchangeCode: (args: ExchangeCodeArgs) => Promise<TokenSet>;
  /** トークン（と claims）→ Identity。emailVerified=false なら新規登録しない。 */
  fetchIdentity: (args: FetchIdentityArgs) => Promise<Identity>;
  /** OIDC provider のみ。alg は RS256 固定（§45 / D-31-04）。 */
  verifyIdToken?: (args: {
    idToken: string;
    nonce: string;
    clientId: string;
  }) => Promise<Record<string, unknown>>;
};