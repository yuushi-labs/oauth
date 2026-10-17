import Link from 'next/link';
import { requireSettingsUser } from '@/app/settings/layout';

const sections = [
  {
    href: '/settings/account',
    title: 'アカウント',
    description: 'ユーザー名・メールアドレス・メール確認状態を確認します。',
  },
  {
    href: '/settings/connected-apps',
    title: '接続済みサービス',
    description: '許可したサービスと共有範囲を確認し、連携を取り消せます。',
  },
  {
    href: '/settings/applications',
    title: 'アプリケーション',
    description: '自作サービス向けの OIDC / OAuth 2.0 アプリ（client）を作成・設定し、接続をテストします。',
  },
] as const;

export default async function SettingsHomePage() {
  const user = await requireSettingsUser();
  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">設定</h1>
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
