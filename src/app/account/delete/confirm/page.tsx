import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { AccountDeleteConfirmForm } from '@/app/account/delete/confirm/account-delete-confirm-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

/**
 * メール確認による退会の確定画面（§24）。
 *
 * `POST /api/auth/account/delete/request` が送るメール内 URL は
 * `/api/auth/account/delete/confirm?token=...`。その GET は 303 でこのページへ転送する。
 * ここでの確定は POST のみ（§25）。
 */
export default async function AccountDeleteConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
        <ThemeToggle />
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">{m('accountDelete.confirmTitle')}</h1>
        <p className="mb-6 text-sm text-muted-fg">{m('accountDelete.warningBody')}</p>
        <AccountDeleteConfirmForm token={token ?? ''} />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">{m('common.backToLogin')}</Link>
        </p>
      </section>
    </main>
  );
}
