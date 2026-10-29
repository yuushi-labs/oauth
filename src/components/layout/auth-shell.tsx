import Link from 'next/link';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';
import { ThemeToggle } from '@/components/theme/theme-toggle';

/**
 * 認証系ページ（ログイン / 登録 / 再設定 / 確認 / 退会 など）の共通レイアウト。
 *
 * 5 ページ以上で重複していた「ブランドヘッダー＋中央寄せカード＋戻るリンク」を 1 か所に
 * 集約する。見出しは各ページが `title` で渡し、`<h1>` は 1 ページに 1 つに保つ（SEO / a11y）。
 * スキップリンクの飛び先 `#main-content` もここで付ける。
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** カードの外側に置く補足（「ログインに戻る」など）。 */
  footer?: React.ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link className="text-2xl font-bold" href="/login">
            {APP_NAME}
          </Link>
          <p className="mt-2 text-sm text-muted-fg">{APP_DESCRIPTION}</p>
        </div>
        <ThemeToggle />
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        {title && <h1 className="text-xl font-semibold">{title}</h1>}
        {description && (
          <p className={title ? 'mt-2 text-sm text-muted-fg' : 'text-sm text-muted-fg'}>
            {description}
          </p>
        )}
        <div className={title || description ? 'mt-6' : undefined}>{children}</div>
      </section>
      {footer}
    </main>
  );
}
