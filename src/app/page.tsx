import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LogoutButton } from '@/app/logout-button';
import { getSession } from '@/lib/auth/session';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { APP_NAME } from '@/config/app';
import { findUserById } from '@/lib/db/queries/users';

const destinations = [
  { href: '/settings', title: '設定メニュー', description: 'アカウント・接続済みサービス・アプリケーション' },
  { href: '/settings/connected-apps', title: '接続済みサービス', description: '許可した連携の確認と取り消し' },
  { href: '/settings/applications', title: 'アプリケーション', description: 'OIDC / OAuth 2.0 アプリの作成と接続テスト' },
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
      <header>
        <h1 className="text-2xl font-bold">{APP_NAME}</h1>
        <p className="mt-2 text-muted-fg">{user.username} さんがログインしています。</p>
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
      <LogoutButton />
    </main>
  );
}
