import { and, eq, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ConnectedApps } from '@/app/settings/connected-apps/connected-apps';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import { getDb } from '@/lib/db/client';
import { oauthClients, oidcUserGrants } from '@/lib/db/schema';

export default async function ConnectedAppsPage() {
  const token = (await cookies()).get(getSessionCookieName())?.value;
  if (!token) redirect('/login');
  const session = await getSession(token);
  if (!session || !await findUserById(session.userId)) redirect('/login');

  const rows = await getDb().select({
    id: oidcUserGrants.id,
    name: oauthClients.name,
    operator: oauthClients.operator,
    scopes: oidcUserGrants.scopes,
    clientActive: oauthClients.active,
    lastUsedAt: oidcUserGrants.lastUsedAt,
  }).from(oidcUserGrants)
    .innerJoin(oauthClients, eq(oidcUserGrants.clientId, oauthClients.clientId))
    .where(and(eq(oidcUserGrants.userId, session.userId), isNull(oidcUserGrants.revokedAt)));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-12">
      <ConnectedApps grants={rows.map((row) => ({ ...row, lastUsedAt: row.lastUsedAt?.toISOString() ?? null }))} />
      <Link className="text-sm text-primary underline" href="/">アカウントへ戻る</Link>
    </main>
  );
}
