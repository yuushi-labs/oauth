import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { SettingsNav } from '@/app/settings/settings-nav';
import { LogoutButton } from '@/app/logout-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { APP_NAME } from '@/config/app';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import { findTotpByUserId } from '@/lib/db/queries/totp';
import { isAdminRole } from '@/lib/auth/admin-policy';
import { m } from '@/messages/ja';
import type { User } from '@/lib/db/schema';

export type AdminUser = { id: string; username: string; email: string; roleId: string };

/**
 * 管理画面のサーバー側ガード（Phase 7.5 / §49）。
 *
 * セッション → user → role ≥ admin の順に検証する。認可はサーバー側のみで行い、
 * フロントの表示制御は UX のための補助にすぎない。管理者でなければ設定画面へ戻す。
 */
export const requireAdminUser = cache(
  async (): Promise<{ user: AdminUser; twoFactorEnabled: boolean }> => {
    const token = (await cookies()).get(getSessionCookieName())?.value;
    const session = token ? await getSession(token) : null;
    if (!session) redirect('/login');
    if (session.totpPending) redirect('/login');

    const user: User | null = await findUserById(session.userId);
    if (!user || user.deletedAt) redirect('/login');
    if (!isAdminRole(user.roleId)) redirect('/settings/security');

    const totp = await findTotpByUserId(user.id);
    return {
      user: { id: user.id, username: user.username, email: user.email, roleId: user.roleId },
      twoFactorEnabled: Boolean(totp?.enabled),
    };
  },
);

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { twoFactorEnabled } = await requireAdminUser();

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
        <SettingsNav isAdmin />
        <div className="min-w-0 flex-1">
          {twoFactorEnabled ? (
            children
          ) : (
            <main id="main-content" className="flex flex-col gap-4">
              <h1 className="text-2xl font-bold">{m('admin.title')}</h1>
              <Alert variant="warning">
                <AlertDescription>
                  <p className="font-semibold">{m('admin.twoFactorRequired')}</p>
                  <p>{m('admin.twoFactorRequiredHint')}</p>
                  <Link className="mt-2 inline-block underline" href="/settings/security">
                    {m('admin.goToSecurity')}
                  </Link>
                </AlertDescription>
              </Alert>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
