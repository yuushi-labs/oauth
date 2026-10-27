import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

/** パスワード再設定の入口。応答は登録の有無で変わらない（§46）。 */
export default async function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
        <ThemeToggle />
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">{m('auth.forgotTitle')}</h1>
        <p className="mb-6 text-sm text-muted-fg">{m('auth.forgotDescription')}</p>
        <ForgotPasswordForm />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">{m('common.backToLogin')}</Link>
        </p>
      </section>
    </main>
  );
}
