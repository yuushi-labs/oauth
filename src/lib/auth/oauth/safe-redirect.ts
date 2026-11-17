/**
 * ログイン後の戻り先（`redirect_to`）を「同一オリジンの相対パス」だけに限定する。
 *
 * **なぜ独立したモジュールなのか**: 戻り先は同意画面・state 行・DB を経由して最後に
 * `NextResponse.redirect` へ渡る。どこか 1 か所でだけ検証すると、途中で値が差し替わった
 * 場合に素通りしてしまう（Aikido: Open redirect / Issue #2）。保存時（`issueOAuthState`）と
 * **リダイレクト直前**の両方で、この同じ関数を通す。
 *
 * 受理するのは `/` で始まる相対パスのみ。絶対 URL・プロトコル相対（`//host`）・
 * バックスラッシュ細工（`/\host`）・制御文字はすべて拒否する。`new URL(path, base)` は
 * base のオリジンを保つので、ここを通った値は必ず自サイト内に留まる。
 */

/** 戻り先として受理する最大長（過剰に長い値を state 行へ載せない）。 */
const MAX_REDIRECT_PATH_LENGTH = 200;

/** 改行・NUL などの ASCII 制御文字は URL の解釈をずらすため拒否する。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** 同一オリジンの相対パスとして安全に使えるか。 */
export function isSafeRedirectPath(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (CONTROL_CHARS.test(value)) return false;
  return true;
}

/**
 * 安全でない値は null に落とす（`issueOAuthState` が DB へ保存する形）。
 * 落ちた場合は呼び出し側が `/` へ戻すので、失敗を握っても安全性は維持される。
 */
export function normalizeRedirectTo(value: string | null | undefined): string | null {
  if (!isSafeRedirectPath(value)) return null;
  return value.slice(0, MAX_REDIRECT_PATH_LENGTH);
}

/**
 * リダイレクト直前に使う最終防衛線。安全でない値は fallback（既定 `/`）へ置き換える。
 * ここを通した値だけを `new URL(path, base)` に渡すこと。
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  return normalizeRedirectTo(value) ?? fallback;
}
