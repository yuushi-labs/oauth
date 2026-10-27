import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { EmailChangeForm } from '@/app/email-change/confirm/email-change-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

/**
 * `POST /api/auth/email/change` が送るメール内 URL は
 * `/api/auth/email/change/confirm?token=...`。その GET は 303 でこのページに
 * 転送される（BUG-2 で GET ハンドラを追加）。ここでの確定は POST のみ（§25）。
 */
export default async function EmailChangeConfirmPage({
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
        <h1 className="mb-2 text-xl font-semibold">{m('auth.emailChangeTitle')}</h1>
        <p className="mb-6 text-sm text-muted-fg">{m('auth.emailChangeDescription')}</p>
        <EmailChangeForm token={token ?? ''} />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">{m('common.backToLogin')}</Link>
        </p>
      </section>
    </main>
  );
}