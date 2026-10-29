import type { MetadataRoute } from 'next';
import { APP_DESCRIPTION, APP_NAME, APP_THEME_COLOR_LIGHT } from '@/config/app';

/**
 * Web App Manifest（`/manifest.webmanifest`）。
 * 認証画面はインストール型アプリにする必然性が薄いので `display: 'browser'` のまま、
 * 名前・テーマ色・アイコンだけを与えてブラウザ/OS の見え方を整える。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'browser',
    lang: 'ja',
    dir: 'ltr',
    background_color: APP_THEME_COLOR_LIGHT,
    theme_color: APP_THEME_COLOR_LIGHT,
    icons: [{ src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  };
}
