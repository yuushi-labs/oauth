import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SettingsNav } from '@/app/settings/settings-nav';
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
  const user: User | null = await findUserById(session.userId);
  if (!user) redirect('/login');
  return { id: user.id, username: user.username, email: user.email, roleId: user.roleId };
});

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsUser();
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <SettingsNav />
      {children}
    </div>
  );
}
