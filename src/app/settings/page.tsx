import Link from 'next/link';
import { requireSettingsUser } from '@/app/settings/layout';
import { m } from '@/messages/ja';

const sections = [
  { href: '/settings/account', title: m('settings.account'), description: 'ユーザー名・メールアドレス・メール確認状態を確認します。' },
  { href: '/settings/security', title: m('settings.security'), description: 'パスワード・2段階認証・Passkey・連携・セッションをまとめて確認します。' },
  { href: '/settings/sessions', title: m('settings.sessions'), description: 'ログイン中のデバイスを確認し、個別にログアウトできます。' },
  { href: '/settings/password', title: m('settings.password'), description: 'パスワードを変更します（変更すると他のデバイスからログアウトされます）。' },
  { href: '/settings/appearance', title: m('settings.appearance'), description: 'テーマ（システムに追従／ライト／ダーク）を選びます。' },
  { href: '/settings/connected-apps', title: m('settings.connectedApps'), description: '許可したサービスと共有範囲を確認し、連携を取り消せます。' },
  { href: '/settings/applications', title: m('settings.applications'), description: 'OIDC / OAuth 2.0 アプリ（client）を作成・設定し、接続をテストします。' },
] as const;

export default async function SettingsHomePage() {
  const user = await requireSettingsUser();
  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('settings.title')}</h1>
        <p className="mt-2 text-sm text-muted-fg">{user.username} さんの設定メニューです。</p>
      </header>
      <ul className="grid gap-4">
        {sections.map((section) => (
          <li key={section.href} className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold">
              <Link className="underline" href={section.href}>{section.title}</Link>
            </h2>
            <p className="mt-2 text-sm text-muted-fg">{section.description}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}