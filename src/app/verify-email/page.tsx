import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { VerifyEmailForm } from '@/app/verify-email-form';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="flex items-start justify-between gap-3">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
        <ThemeToggle />
      </header>
      <div>
        <h1 className="mb-2 text-center text-xl font-semibold">{m('auth.verifyTitle')}</h1>
        <p className="mb-6 text-center text-sm text-muted-fg">{m('auth.verifyDescription')}</p>
        <VerifyEmailForm token={token ?? ''} />
      </div>
    </main>
  );
}