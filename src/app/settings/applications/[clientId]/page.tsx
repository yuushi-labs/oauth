import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { requireSettingsUser } from '@/app/settings/layout';
import { ApplicationDetail } from '@/app/settings/applications/[clientId]/application-detail';
import {
  findOidcClient,
  OidcClientForbiddenError,
  OidcClientNotFoundError,
  requireManageableClient,
} from '@/lib/oidc/clients';
import { connectionTestRedirectUri } from '@/lib/oidc/client-validation';
import { getEnv } from '@/lib/env';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: m('applications.detailTitle') };

type PageProps = { params: Promise<{ clientId: string }> };

export default async function ApplicationDetailPage({ params }: PageProps) {
  const user = await requireSettingsUser();
  const { clientId } = await params;

  try {
    await requireManageableClient(clientId, user.id);
  } catch (error) {
    if (error instanceof OidcClientNotFoundError || error instanceof OidcClientForbiddenError)
      notFound();
    throw error;
  }

  const client = await findOidcClient(clientId);
  if (!client) notFound();

  const env = getEnv();
  const issuer = env.OIDC_ISSUER ?? new URL(env.NEXT_PUBLIC_APP_URL).origin;

  return (
    <main id="main-content">
      <ApplicationDetail
        client={{
          clientId: client.clientId,
          name: client.name,
          operator: client.operator,
          clientType: client.clientType === 'public' ? 'public' : 'confidential',
          redirectUris: client.redirectUris,
          allowedScopes: client.allowedScopes,
          webOrigins: client.webOrigins,
          active: client.active,
          createdAt: client.createdAt,
          ownerUsername: client.ownerUsername,
          issuer,
          discoveryUrl: new URL('/.well-known/openid-configuration', issuer).toString(),
          testRedirectUri: connectionTestRedirectUri(env.NEXT_PUBLIC_APP_URL),
        }}
      />
    </main>
  );
}
