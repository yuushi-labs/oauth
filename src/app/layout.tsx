import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'oauth',
  description: '超本格アカウント・認証システム',
};

/**
 * 描画前にテーマを確定して FOUC を防ぐ（仕様39-42）。
 * 静的な既定値のみを扱い、ユーザー入力を interpolating しない。
 * CSP nonce は Phase 2（P2-01a）で導入届时き header と紐付ける。
 */
const themeInitScript = [
  '(function(){try{',
  'var t=localStorage.getItem("theme")||"system";',
  'var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);',
  'document.documentElement.dataset.theme=d?"dark":"light";',
  '}catch(e){document.documentElement.dataset.theme="light";}})();',
].join('');

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-bg text-fg min-h-screen antialiased">{children}</body>
    </html>
  );
}