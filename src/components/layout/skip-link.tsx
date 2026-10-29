/**
 * キーボード利用者向けのスキップリンク（WCAG 2.4.1）。
 * 既定は画面外に置き、Tab でフォーカスされたときだけ左上に出す。
 * リンク先は各ページの本文 `<main id="main-content">`。
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only rounded-md border border-border-strong bg-card px-4 py-2 text-sm font-medium text-fg shadow-lg focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      本文へスキップ
    </a>
  );
}
