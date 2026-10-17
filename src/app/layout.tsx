import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';
import { buildThemeInitScript } from '@/components/theme/theme-script';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { normalizeTheme } from '@/lib/theme/resolver';
import './globals.css';

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
};

/**
 * 描画前にテーマを確定して FOUC を防ぐ（§39-42 / D-30-04）。
 * ログイン済みは server の user_preferences を、無ければ localStorage → system の順に解決する。
 * CSP nonce は middleware から受け取り、静的な値（enum 検証済み）だけを埋め込む。
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  // このインライン script は描画前に同期実行されるため nonce 必須（CSP は 'strict-dynamic' + nonce のみ許可）。
  //
  // suppressHydrationWarning が無いと hydration mismatch が出るが、これは**誤検出**：
  // ブラウザは nonce を CSS 属性セレクタからの窃取を防ぐため `getAttribute('nonce')` で
  // 空文字を返す（HTML 仕様）。React は.server の値と空文字を比較して警告するが、
  // 実際の DOM には正しい nonce が入っており、React も意図的に上書きしない。
  // `<html suppressHydrationWarning>` は1段しか無効化しないので、script 自身に付ける。
  const sessionToken = (await cookies()).get(getSessionCookieName())?.value;
  // sessions.user_id は ON DELETE CASCADE なので、有効なセッションがあれば user も必ず存在する。
  // そのためレイアウトで findUserById を呼ぶ必要はない（毎リクエストの DB 往復を1回減らす）。
  const session = sessionToken ? await getSession(sessionToken) : null;
  const preferences = session ? await getUserPreferences(session.userId) : null;
  const theme = normalizeTheme(preferences?.theme);

  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: buildThemeInitScript(theme) }}
        />
      </head>
      <body className="bg-bg text-fg min-h-screen antialiased">
        <ThemeProvider initialPreference={theme} authenticated={Boolean(session)}>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}