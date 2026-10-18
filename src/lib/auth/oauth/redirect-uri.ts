import { getEnv } from '@/lib/env';
import type { OAuthProviderId } from './types';

/**
 * redirect_uri は **server 側の設定（NEXT_PUBLIC_APP_URL）から組み立てる**（D-31-01）。
 *
 * リクエストの `Host` ヘッダから導出してはいけない。`Host` は攻撃者が制御しうるので、
 * そのまま使うと認可コードを攻撃者名義のアプリケーションへ送る 공격が可能になる
 * （authorization code injection の起点）。Phase 6 の `WEBAUTHN_ORIGIN` と同じ判断。
 */
export function redirectUriFor(provider: OAuthProviderId): string {
  const base = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/api/auth/oauth/${provider}/callback`;
}