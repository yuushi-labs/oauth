import { DEFAULT_THEME, DARK_MEDIA_QUERY, THEME_STORAGE_KEY, normalizeTheme, type ThemePreference } from '@/lib/theme/resolver';

/**
 * 描画前にテーマを確定して FOUC を防ぐ同期スクリプト（§39-42 / D-30-04）。
 *
 * 優先順位: **server から渡された値 → localStorage → 既定(system)**
 * ユーザー入力を補間しない。pref は enum 検証済みで 3 値のみが埋め込まれる。
 */
export function buildThemeInitScript(serverPreference: ThemePreference = DEFAULT_THEME): string {
  const preference = normalizeTheme(serverPreference);
  return [
    '(function(){try{',
    `var s=${JSON.stringify(preference)};`,
    `var t=(s&&s!=="system")?s:(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||${JSON.stringify(DEFAULT_THEME)});`,
    `var d=t==="dark"||(t==="system"&&window.matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches);`,
    'document.documentElement.dataset.theme=d?"dark":"light";',
    `try{localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},t);}catch(e){}`,
    '}catch(e){document.documentElement.dataset.theme="light";}})();',
  ].join('');
}