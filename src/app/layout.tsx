import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';
import './globals.css';

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
};

/**
 * 描画前にテーマを確定して FOUC を防ぐ（仕様39-42）。
 * 静的な既定値のみを扱い、ユーザー入力を interpolating しない。
 * CSP nonce は middleware から受け取り、インライン script に渡す。
 */
const themeInitScript = [
  '(function(){try{',
  'var t=localStorage.getItem("theme")||"system";',
  'var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);',
  'document.documentElement.dataset.theme=d?"dark":"light";',
  '}catch(e){document.documentElement.dataset.theme="light";}})();',
].join('');

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-bg text-fg min-h-screen antialiased">{children}</body>
    </html>
  );
}
