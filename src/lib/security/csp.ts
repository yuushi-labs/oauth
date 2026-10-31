/**
 * Content-Security-Policy の組み立て（§28）。
 *
 * middleware から分離して純関数にしているのは、Turnstile の許可追加（BUG-22）を
 * HTTP を起こさず単体テストで固定するため。
 */

/** Turnstile のウィジェット／チャレンジ iframe が読み込まれる origin（D-39-01）。 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export type CspOptions = {
  /** インライン script 用の nonce。 */
  nonce: string;
  /** 開発時のみ `'unsafe-eval'`（Next の Fast Refresh）を許可する。 */
  allowEval: boolean;
  /**
   * Turnstile を有効にするか。有効なときだけ `challenges.cloudflare.com` を
   * `script-src` / `frame-src` に足す。無効時は最小権限のまま（既定）。
   */
  turnstile: boolean;
};

export function contentSecurityPolicy({ nonce, allowEval, turnstile }: CspOptions): string {
  const scriptDirective = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(turnstile ? [TURNSTILE_ORIGIN] : []),
    ...(allowEval ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    scriptDirective,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    // Turnstile はチャレンジを iframe で描画する。frame-src を明示しないと
    // default-src 'self' にフォールバックしてブロックされる。
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
