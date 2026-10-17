/**
 * 社会ログイン provider の registry（計画 P4-A-01 / D-30-21）。
 *
 * **1 エントリ追加で有効化し、UI は registry から自動生成する**。
 * Phase 3 では空なので、ログイン画面の社会ログインボタンは描画されない。
 * Phase 4 で Google / GitHub / Discord を追加すると自動的にボタンが現れる。
 *
 * ここで定義するのは「表示に必要なメタデータと検証関数」だけ。実際のトークン交換は
 * Phase 4 の `lib/auth/oauth/*` が担う（秘密値をこのファイルには書かない）。
 */
export type OAuthProviderId = 'google' | 'github' | 'discord';

export type OAuthProviderEntry = {
  id: OAuthProviderId;
  /** ボタンに表示する表示名 */
  label: string;
  /** client_id が設定されているかどうか。未設定ならボタンを描画しない */
  isConfigured: (env: Record<string, string | undefined>) => boolean;
  /** authorize エンドポイント（検証用の正本。実行時に導出しない） */
  authorizationEndpoint: string;
  /** 要求する scope（最小権限・D-06） */
  scope: string;
  /** OIDC provider の場合は nonce / signature 検証が要る */
  protocol: 'oidc' | 'oauth2';
};

export const OAUTH_PROVIDER_REGISTRY: readonly OAuthProviderEntry[] = [
  // Phase 4 で以下のようにエントリを追加する:
  // {
  //   id: 'google',
  //   label: 'Google',
  //   isConfigured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  //   authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  //   scope: 'openid email profile',
  //   protocol: 'oidc',
  // },
] as const;

/** 設定済みの provider だけを返す。0 件なら UI は領域ごと描画しない（D-30-21）。 */
export function configuredOAuthProviders(
  env: Record<string, string | undefined>,
): OAuthProviderEntry[] {
  return OAUTH_PROVIDER_REGISTRY.filter((provider) => provider.isConfigured(env));
}

export function isEmptyRegistry(): boolean {
  return OAUTH_PROVIDER_REGISTRY.length === 0;
}