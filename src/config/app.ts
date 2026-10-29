/** User-facing application branding. Change NEXT_PUBLIC_APP_NAME to rename the app. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'oauth';
export const APP_DESCRIPTION = 'メールアドレスとパスワードで安全にアカウントを管理します。';

/** サイトの正規 URL。metadataBase と OG の絶対 URL に使う（末尾スラッシュなし）。 */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000').replace(
  /\/+$/,
  '',
);

/**
 * `<meta name="theme-color">` の値。globals.css の --bg と一致させる（ブラウザ UI の色）。
 * light: --bg=#ffffff / dark: --bg=#0b0f19。
 */
export const APP_THEME_COLOR_LIGHT = '#ffffff';
export const APP_THEME_COLOR_DARK = '#0b0f19';
