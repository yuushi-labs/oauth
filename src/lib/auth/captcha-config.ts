/**
 * Cloudflare Turnstile の**公開**設定（Phase 9 / D-39-01）。
 *
 * Turnstile は鍵が 2 つ必要:
 * - site key（`NEXT_PUBLIC_TURNSTILE_SITE_KEY`）… ブラウザがウィジェットを描画する。公開情報。
 * - secret（`TURNSTILE_SECRET_KEY`）… サーバが `siteverify` を叩く。**秘匿**（`captcha.ts` のみが読む）。
 *
 * この module は `process.env` を読むだけの純粋な resolver で、server / client の双方から
 * 安全に import できる（node API を使わない）。ただし `NEXT_PUBLIC_*` をクライアント
 * コンポーネントで直接読むと hydration mismatch を招くため（BUG-11）、実際には
 * **サーバ側で解決して props で渡す**。
 */

const TURNSTILE_SITE_KEY_ENV = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY';

/** ウィジェット描画用の site key。未設定なら undefined（＝CAPTCHA 無効）。 */
export function turnstileSiteKey(): string | undefined {
  const value = process.env[TURNSTILE_SITE_KEY_ENV]?.trim();
  return value ? value : undefined;
}

/** サーバ検証用の secret が設定されているか（値は返さない）。 */
export function turnstileSecretConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

/**
 * 設定の整合性を検証する（本番の起動時に呼ぶ）。
 *
 * site key と secret は**両方そろって初めて機能する**。片方だけだと:
 * - secret のみ → ウィジェットが出ず token が常に null → ソフトリミット超過時に必ず
 *   `CAPTCHA_INVALID`(400)。突破不能なのに「設定済み」に見える（BUG-22 の実態）。
 * - site key のみ → ウィジェットは出るがサーバが検証できず `CAPTCHA_UNCONFIGURED`(500)。
 *
 * どちらも気付きにくいので、本番では起動時に fail fast させる。
 */
export function assertCaptchaConfigConsistent(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const hasSiteKey = Boolean(turnstileSiteKey());
  const hasSecret = turnstileSecretConfigured();
  if (hasSiteKey === hasSecret) return;

  const missing = hasSecret ? TURNSTILE_SITE_KEY_ENV : 'TURNSTILE_SECRET_KEY';
  throw new Error(
    `CAPTCHA の設定が不完全です: ${missing} が未設定です。` +
      `Turnstile を使うには ${TURNSTILE_SITE_KEY_ENV} と TURNSTILE_SECRET_KEY の両方が必要です。` +
      '（どちらも未設定なら CAPTCHA は無効のまま fail-closed で動作します）',
  );
}
