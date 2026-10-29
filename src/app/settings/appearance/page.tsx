import { requireSettingsUser } from '@/app/settings/layout';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { ThemeForm } from '@/components/settings/theme-form';
import type { Metadata } from 'next';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('theme.title') };

export const dynamic = 'force-dynamic';

/** 外観（テーマ 3 択）。§39/§40。保存は `PATCH /api/auth/preferences`（D-30-07）。 */
export default async function SettingsAppearancePage() {
  const user = await requireSettingsUser();
  const preferences = await getUserPreferences(user.id);

  return (
    <main id="main-content" className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('theme.title')}</h1>
      </header>
      <ThemeForm initialTheme={preferences.theme} timezone={preferences.timezone} />
    </main>
  );
}
