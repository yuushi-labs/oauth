import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { m } from '@/messages/ja';

/** 404。静的なので Next が自動で返す。 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header>
        <Link className="text-2xl font-bold" href="/">{APP_NAME}</Link>
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">{m('error.notFoundTitle')}</h1>
        <p className="mb-6 text-sm text-muted-fg">{m('error.notFoundDescription')}</p>
        <Link className="underline" href="/">{m('common.backToHome')}</Link>
      </section>
    </main>
  );
}
