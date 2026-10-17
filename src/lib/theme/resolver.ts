/**
 * テーマ解決の純関数（§39〜§41）。
 * ブラウザ API（matchMedia / localStorage / document）はここで使わないので、
 * node 環境で unit テストできる（spec 13.2 / D-30-03）。
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';
export const DEFAULT_THEME: ThemePreference = 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'] as const;

export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** 不正値は既定（system）に落とす（localStorage を汚收音象でも無害に動く）。 */
export function normalizeTheme(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME;
}

/** 明示指定（light/dark）は端末設定を無視する（§39）。 */
export function resolveEffectiveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(normalizeTheme(current));
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]!;
}