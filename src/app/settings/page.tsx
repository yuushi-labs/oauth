import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AppWindow,
  ArrowRight,
  KeyRound,
  Link2,
  MonitorSmartphone,
  Palette,
  Plug,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { requireSettingsUser } from '@/app/settings/layout';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('settings.title') };

const sections: readonly { href: string; title: string; description: string; Icon: LucideIcon }[] =
  [
    {
      href: '/settings/account',
      title: m('settings.account'),
      description: 'ユーザー名・メールアドレス・メール確認状態を確認します。',
      Icon: UserRound,
    },
    {
      href: '/settings/security',
      title: m('settings.security'),
      description: 'パスワード・2 段階認証・Passkey・連携・セッションをまとめて確認します。',
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
      description: 'パスワードを変更します（変更すると他のデバイスからログアウトされます）。',
      Icon: KeyRound,
    },
    {
      href: '/settings/appearance',
      title: m('settings.appearance'),
      description: 'テーマ（システムに追従／ライト／ダーク）を選びます。',
      Icon: Palette,
    },
    {
      href: '/settings/connected-accounts',
      title: m('settings.connectedAccounts'),
      description:
        'Google / GitHub / Discord などの外部アカウントを連携し、外部アカウントでログインできるようにします。',
      Icon: Link2,
    },
    {
      href: '/settings/connected-apps',
      title: m('settings.connectedApps'),
      description: '許可したサービスと共有範囲を確認し、連携を取り消せます。',
      Icon: Plug,
    },
    {
      href: '/settings/applications',
      title: m('settings.applications'),
      description: 'OIDC / OAuth 2.0 アプリ（client）を作成・設定し、接続をテストします。',
      Icon: AppWindow,
    },
  ];

export default async function SettingsHomePage() {
  const user = await requireSettingsUser();
  return (
    <main id="main-content" className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('settings.title')}</h1>
        <p className="mt-2 text-sm text-muted-fg">
          <span className="font-medium text-fg">{user.username}</span> さんの設定メニューです。
        </p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2">
        {sections.map(({ href, title, description, Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="group flex h-full items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-muted-fg">
                <Icon aria-hidden className="size-4" />
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
    </main>
  );
}
