import type { Env } from '@/lib/env';

/**
 * `DATABASE_SSL_MODE` から `pg` の `ssl` オプションを組み立てる。
 *
 * - `disable`（既定）: TLS を使わない。DB は localhost のみで待ち受ける前提（デプロイ手順 §4）。
 * - `require`: TLS で暗号化するが証明書は検証しない（自己署名の DB へ接続する場合）。
 * - `verify-full`: TLS で暗号化し証明書も検証する（外部 DB / 正規 CA の場合）。
 *
 * 接続文字列に `sslmode` が含まれる場合はそちらが優先される（`pg` の仕様）。
 */
export function resolveDatabaseSsl(
  mode: Env['DATABASE_SSL_MODE'],
): false | { rejectUnauthorized: boolean } {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}
