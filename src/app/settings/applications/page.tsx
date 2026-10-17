import { requireSettingsUser } from '@/app/settings/layout';
import { ApplicationsConsole } from '@/app/settings/applications/applications-console';
import { listOidcClients } from '@/lib/oidc/clients';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const user = await requireSettingsUser();
  const clients = await listOidcClients({ id: user.id, roleId: user.roleId });

  return (
    <main>
      <ApplicationsConsole
        clients={clients.map((client) => ({
          clientId: client.clientId,
          name: client.name,
          operator: client.operator,
          clientType: client.clientType,
          redirectUris: client.redirectUris,
          allowedScopes: client.allowedScopes,
          webOrigins: client.webOrigins,
          active: client.active,
          createdAt: client.createdAt,
          ownerUsername: client.ownerUsername,
          grantCount: client.grantCount,
          lastUsedAt: client.lastUsedAt,
          isOwner: client.isOwner,
        }))}
        maxClientsPerUser={getEnv().OIDC_MAX_CLIENTS_PER_USER}
      />
    </main>
  );
}
