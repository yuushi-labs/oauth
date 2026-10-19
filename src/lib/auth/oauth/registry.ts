/**
 * 社会ログイン provider の registry（計画 P4-A-01 / D-31-xx）。
 *
 * **1 エントリ追加で有効化し、UI は registry から自動生成する**（D-30-21）。
 * 未設定の provider は `isConfigured` が false を返すので、ログイン画面のボタンも出ない。
 *
 * registry は「どの provider があり、どういう検証をするか」だけを持つ。
 * client_id / client_secret の**値**はここには書かない。実行時に `envKeys` の環境変数から読む（§62）。
 */
import { discord } from './discord';
import { github } from './github';
import { google } from './google';
import type { OAuthProviderEntry, OAuthProviderId } from './types';

export type { OAuthProviderEntry, OAuthProviderId, OAuthIntent, TokenSet, Identity } from './types';

export const OAUTH_PROVIDER_REGISTRY: readonly OAuthProviderEntry[] = [google, github, discord] as const;

/** 設定済みの provider だけを返す。0 件なら UI は領域ごと描画しない（D-30-21）。 */
export function configuredOAuthProviders(
  env: Record<string, string | undefined>,
): OAuthProviderEntry[] {
  return OAUTH_PROVIDER_REGISTRY.filter((provider) => provider.isConfigured(env));
}

/**
 * id から provider を引く。**未登録と未設定はどちらも null を返す**。
 * callback 側は「どちらだったか」を利用者へ教えない（D-31-xx・404 INVALID_PROVIDER で統一）。
 */
export function getProvider(id: string, env?: Record<string, string | undefined>): OAuthProviderEntry | null {
  const provider = OAUTH_PROVIDER_REGISTRY.find((entry) => entry.id === id);
  if (!provider) return null;
  if (env && !provider.isConfigured(env)) return null;
  return provider;
}

export function isEmptyRegistry(): boolean {
  return OAUTH_PROVIDER_REGISTRY.length === 0;
}

/** registry が持つ env キーを全部集める（UI 側で process.env を渡すときの手書きを避ける）。 */
export function oauthEnvKeys(): readonly string[] {
  return OAUTH_PROVIDER_REGISTRY.flatMap((provider) => [provider.envKeys.clientId, provider.envKeys.clientSecret]);
}