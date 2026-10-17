import Link from 'next/link';
import { requireSettingsUser } from '@/app/settings/layout';
import { findUserById } from '@/lib/db/queries/users';
import { formatLocalDateTime, resolveTimeZone } from '@/lib/util/datetime';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const settingsUser = await requireSettingsUser();
  const [user, preferences] = await Promise.all([
    findUserById(settingsUser.id),
    getUserPreferences(settingsUser.id),
  ]);
  const timezone = resolveTimeZone(preferences.timezone);
  const createdAt = user?.createdAt.toISOString();

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{m('settings.account')}</h1>
          <p className="mt-2 text-sm text-muted-fg">アカウントの基本情報を確認します。</p>
        </div>
        <ThemeToggle />
      </header>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-3 text-sm">
            <div className="flex flex-col gap-1 sm:flex-row">
              <dt className="w-40 text-muted-fg">ユーザー名</dt>
              <dd>{user?.username}</dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row">
              <dt className="w-40 text-muted-fg">{m('security.email')}</dt>
              <dd className="flex items-center gap-2">
                {user?.email}
                <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-semibold">
                  {user?.emailVerified ? m('security.emailVerified') : m('security.emailUnverified')}
                </span>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row">
              <dt className="w-40 text-muted-fg">登録日時</dt>
              <dd>
                <time dateTime={createdAt}>{formatLocalDateTime(createdAt ?? '', timezone)}</time>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row">
              <dt className="w-40 text-muted-fg">{m('preferences.timezone')}</dt>
              <dd>{timezone}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div>
        <Link
          className="inline-flex h-8 items-center justify-center rounded-md border border-border-strong px-3 text-xs font-medium text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="/settings/appearance"
        >
          {m('settings.appearance')}
        </Link>
      </div>
    </main>
  );
}