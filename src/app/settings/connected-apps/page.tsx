import { requireSettingsUser } from '@/app/settings/layout';
import { ConnectedApps } from '@/app/settings/connected-apps/connected-apps';
import { getDb } from '@/lib/db/client';
import { oauthClients, oidcUserGrants } from '@/lib/db/schema';
import type { Metadata } from 'next';
import { and, eq, isNull } from 'drizzle-orm';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('settings.connectedApps') };

export default async function ConnectedAppsPage() {
  const user = await requireSettingsUser();

  const rows = await getDb()
    .select({
      id: oidcUserGrants.id,
      name: oauthClients.name,
      operator: oauthClients.operator,
      scopes: oidcUserGrants.scopes,
      clientActive: oauthClients.active,
      lastUsedAt: oidcUserGrants.lastUsedAt,
    })
    .from(oidcUserGrants)
    .innerJoin(oauthClients, eq(oidcUserGrants.clientId, oauthClients.clientId))
    .where(and(eq(oidcUserGrants.userId, user.id), isNull(oidcUserGrants.revokedAt)));

  return (
    <main id="main-content" className="flex flex-col gap-6">
      <ConnectedApps
        grants={rows.map((row) => ({ ...row, lastUsedAt: row.lastUsedAt?.toISOString() ?? null }))}
      />
    </main>
  );
}
