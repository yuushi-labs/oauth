import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SettingsNav } from '@/app/settings/settings-nav';
import { LogoutButton } from '@/app/logout-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { APP_NAME } from '@/config/app';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import type { User } from '@/lib/db/schema';

export type SettingsUser = { id: string; username: string; email: string; roleId: string };

/** Server-side guard: every settings page requires a live session and an existing user. */
export const requireSettingsUser = cache(async (): Promise<SettingsUser> => {
  const token = (await cookies()).get(getSessionCookieName())?.value;
  const session = token ? await getSession(token) : null;
  if (!session) redirect('/login');
  // 2FA 保留セッションは画面遷移でも弾く（API だけだと画面が出てから 403 が連発する・D-33-08）。
  if (session.totpPending) redirect('/login');
  const user: User | null = await findUserById(session.userId);
  if (!user) redirect('/login');
  return { id: user.id, username: user.username, email: user.email, roleId: user.roleId };
});

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsUser();
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link className="text-lg font-bold" href="/">
          {APP_NAME}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
