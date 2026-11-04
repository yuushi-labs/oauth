/** User-facing application branding. Change NEXT_PUBLIC_APP_NAME to rename the app. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'oauth';
export const APP_DESCRIPTION = 'メールアドレスとパスワードで安全にアカウントを管理します。';

/**
 * パスワード再設定などのセルフサービス復旧を行えない場合の連絡先（Discord）。
 * メール送受信が使えないため、本人確認を伴わないメール経由の復旧は提供しない（§54 / §55）。
 */
export const SUPPORT_DISCORD = process.env.NEXT_PUBLIC_SUPPORT_DISCORD?.trim() || '@yuushi_2024';

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
