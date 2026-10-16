import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LogoutButton } from '@/app/logout-button';
import { findUserById } from '@/lib/db/queries/users';
import { getSession } from '@/lib/auth/session';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { APP_NAME } from '@/config/app';
import Link from 'next/link';

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
        <p className="mt-2 text-muted-fg">ログインしています。</p>
      </header>
      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">アカウント</h2>
        <dl className="mt-4 grid gap-3 text-sm">
          <div><dt className="text-muted-fg">ユーザー名</dt><dd>{user.username}</dd></div>
          <div><dt className="text-muted-fg">メールアドレス</dt><dd>{user.email}</dd></div>
          <div><dt className="text-muted-fg">メール確認</dt><dd>{user.emailVerified ? '確認済み' : '未確認'}</dd></div>
        </dl>
      </section>
      <Link className="text-sm text-primary underline" href="/settings/connected-apps">接続済みサービスを管理</Link>
      <LogoutButton />
    </main>
  );
}
