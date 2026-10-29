import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, KeyRound, MonitorSmartphone, ShieldCheck, UserRound } from 'lucide-react';
import { LogoutButton } from '@/app/logout-button';
import { getSession } from '@/lib/auth/session';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { APP_NAME } from '@/config/app';
import { findUserById } from '@/lib/db/queries/users';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Card, CardContent } from '@/components/ui/card';
import { m } from '@/messages/ja';

// ルート `page.tsx` は `layout.tsx` と同じセグメントなので `title.template` が効かない。
// 他ページと表記を揃えるため absolute で組み立てる。
export const metadata: Metadata = { title: { absolute: `ホーム | ${APP_NAME}` } };

const destinations = [
  {
    href: '/settings/account',
    title: m('settings.account'),
    description: 'ユーザー名・メールアドレス・登録情報を確認します。',
    Icon: UserRound,
  },
  {
    href: '/settings/security',
    title: m('settings.security'),
    description: 'パスワード・2 段階認証・Passkey・連携をまとめて確認します。',
    Icon: ShieldCheck,
  },
  {
    href: '/settings/sessions',
    title: m('settings.sessions'),
    description: 'ログイン中のデバイスを確認し、個別にログアウトできます。',
    Icon: MonitorSmartphone,
  },
  {
    href: '/settings/password',
    title: m('settings.password'),
    description: 'パスワードを変更します。',
    Icon: KeyRound,
  },
] as const;

export default async function HomePage() {
  const sessionToken = (await cookies()).get(getSessionCookieName())?.value;
  if (!sessionToken) redirect('/login');

  const session = await getSession(sessionToken);
  if (!session) redirect('/login');
  const user = await findUserById(session.userId);
  if (!user) redirect('/login');

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{APP_NAME}</h1>
          <p className="mt-2 text-muted-fg">
            <span className="font-medium text-fg">{user.username}</span> さんがログインしています。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>

      <nav aria-label={m('settings.title')}>
        <ul className="grid gap-4 sm:grid-cols-2">
          {destinations.map(({ href, title, description, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex h-full items-start gap-4 rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-strong hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-hover text-muted-fg">
                  <Icon aria-hidden className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-base font-semibold text-fg">
                    {title}
                    <ArrowRight
                      aria-hidden
                      className="size-4 shrink-0 text-muted-fg transition-transform group-hover:translate-x-0.5"
                    />
                  </span>
                  <span className="mt-1 block text-sm text-muted-fg">{description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Card>
        <CardContent className="pt-6 text-sm text-muted-fg">
          {m('settings.title')} から、アカウント・セキュリティ・アプリケーションを管理できます。
        </CardContent>
      </Card>
    </main>
  );
}
