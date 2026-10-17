import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';
import { buildThemeInitScript } from '@/components/theme/theme-script';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
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

  const sessionToken = (await cookies()).get(getSessionCookieName())?.value;
  const session = sessionToken ? await getSession(sessionToken) : null;
  const user = session ? await findUserById(session.userId) : null;
  const preferences = user ? await getUserPreferences(user.id) : null;
  const themeInitScript = buildThemeInitScript(normalizeTheme(preferences?.theme));

  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-bg text-fg min-h-screen antialiased">
        <ThemeProvider
          initialPreference={normalizeTheme(preferences?.theme)}
          authenticated={Boolean(user)}
        >
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}