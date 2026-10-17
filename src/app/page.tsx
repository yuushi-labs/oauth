import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LogoutButton } from '@/app/logout-button';
import { getSession } from '@/lib/auth/session';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { APP_NAME } from '@/config/app';
import { findUserById } from '@/lib/db/queries/users';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

const destinations = [
  { href: '/settings', title: m('settings.title'), description: 'アカウント・セキュリティ・セッション・外観' },
  { href: '/settings/security', title: m('settings.security'), description: 'セキュリティの設定をまとめて確認' },
  { href: '/settings/sessions', title: m('settings.sessions'), description: 'ログイン中のデバイスとログアウト' },
] as const;

export default async function HomePage() {
  const sessionToken = (await cookies()).get(getSessionCookieName())?.value;
  if (!sessionToken) redirect('/login');

  const session = await getSession(sessionToken);
  if (!session) redirect('/login');
  const user = await findUserById(session.userId);
  if (!user) redirect('/login');

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{APP_NAME}</h1>
          <p className="mt-2 text-muted-fg">{user.username} さんがログインしています。</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>
      <ul className="grid gap-4">
        {destinations.map((item) => (
          <li key={item.href} className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold">
              <Link className="underline" href={item.href}>{item.title}</Link>
            </h2>
            <p className="mt-2 text-sm text-muted-fg">{item.description}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}