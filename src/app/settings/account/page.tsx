import { requireSettingsUser } from '@/app/settings/layout';
import { findUserById } from '@/lib/db/queries/users';

export default async function AccountSettingsPage() {
  const settingsUser = await requireSettingsUser();
  const user = await findUserById(settingsUser.id);
  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">アカウント</h1>
        <p className="mt-2 text-sm text-muted-fg">アカウントの基本情報を確認します。</p>
      </header>
      <section className="rounded-lg border border-border bg-card p-6">
        <dl className="grid gap-3 text-sm">
          <div><dt className="text-muted-fg">ユーザー名</dt><dd>{user?.username}</dd></div>
          <div><dt className="text-muted-fg">メールアドレス</dt><dd>{user?.email}</dd></div>
          <div><dt className="text-muted-fg">メール確認</dt><dd>{user?.emailVerified ? '確認済み' : '未確認'}</dd></div>
        </dl>
      </section>
    </main>
  );
}
