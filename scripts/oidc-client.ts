import 'dotenv/config';
import { getPool } from '@/lib/db/client';
import { getEnv } from '@/lib/env';
import { createOidcClient, revokeOidcClient, rotateOidcClientSecret, updateOidcClient } from '@/lib/oidc/clients';
import {
  ClientValidationError,
  connectionTestRedirectUri,
  parseClientInput,
  parseClientUpdateInput,
} from '@/lib/oidc/client-validation';
import type { ClientInput } from '@/lib/oidc/client-validation';

const USAGE = `OIDC client management

  pnpm oidc:client add --name <name> --operator <operator> --type public|confidential --redirect-uri <exact-uri> [--scope openid,profile,email] [--web-origin <origin>]
  pnpm oidc:client update --client-id <id> [--name <name>] [--operator <operator>] [--scope openid,profile,email] [--web-origin <origin>] [--add-redirect-uri <uri>] [--remove-redirect-uri <uri>]
  pnpm oidc:client rotate-secret --client-id <id>
  pnpm oidc:client revoke --client-id <id>
`;

function option(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]!);
  }
  return values;
}

const CLI_ACTOR = { userId: null, ip: '', userAgent: 'oidc-client-cli', trustedOperator: true as const };

async function loadClient(clientId: string): Promise<{
  name: string;
  operator: string;
  client_type: 'public' | 'confidential';
  redirect_uris: string[];
  allowed_scopes: string[];
  web_origins: string[];
}> {
  const result = await getPool().query<{
    name: string;
    operator: string;
    client_type: 'public' | 'confidential';
    redirect_uris: string[];
    allowed_scopes: string[];
    web_origins: string[];
  }>(
    `SELECT name, operator, client_type, redirect_uris, allowed_scopes, web_origins FROM oauth_clients
     WHERE client_id = $1 AND active = true AND revoked_at IS NULL`, [clientId],
  );
  const client = result.rows[0];
  if (!client) throw new Error('Active client not found.');
  return client;
}

function reportScopes(scopes: readonly string[], previous?: readonly string[]): void {
  if (previous && scopes.join(' ') === previous.join(' ')) return;
  process.stdout.write('Scope changes apply to new authorizations; existing grants keep their granted scopes until users re-consent or revoke.\n');
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command === 'add') {
    const input = parseClientInput({
      name: option('--name')[0]?.trim() ?? '',
      operator: option('--operator')[0]?.trim() ?? '',
      clientType: option('--type')[0],
      redirectUris: option('--redirect-uri'),
      scopes: (option('--scope')[0] ?? 'openid').split(','),
      webOrigins: option('--web-origin'),
    });
    const created = await createOidcClient(input as ClientInput, CLI_ACTOR);
    process.stdout.write(`client_id=${created.clientId}\nclient_type=${input.clientType}\noperator=${input.operator}\nredirect_uris=${input.redirectUris.join(',')}\nscopes=${input.scopes.join(' ')}\n`);
    if (created.clientSecret) process.stdout.write(`client_secret=${created.clientSecret}\n`);
    process.stdout.write('Copy the client secret now; only its HMAC is stored and it is shown only once.\n');
    process.stdout.write(`Registered through the CLI. Register through the console (/settings/applications) to show the owner on the consent screen.\n`);
    process.stdout.write(`Console connection test redirect URI (add it manually when you need it): ${connectionTestRedirectUri(getEnv().NEXT_PUBLIC_APP_URL)}\n`);
    return;
  }

  if (command === 'update') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    const client = await loadClient(clientId);
    const scopeOption = option('--scope')[0];
    const redirectUris = [
      ...client.redirect_uris.filter((uri) => !option('--remove-redirect-uri').includes(uri)),
      ...option('--add-redirect-uri'),
    ];
    const input = parseClientUpdateInput({
      name: option('--name')[0]?.trim() ?? client.name,
      operator: option('--operator')[0]?.trim() ?? client.operator,
      redirectUris,
      scopes: scopeOption ? scopeOption.split(',') : client.allowed_scopes,
      webOrigins: option('--web-origin').length ? option('--web-origin') : client.web_origins,
    }, client.client_type);
    await updateOidcClient(clientId, input, CLI_ACTOR);
    process.stdout.write(`Updated ${clientId}. scopes=${input.scopes.join(' ')}\n`);
    reportScopes(input.scopes, client.allowed_scopes);
    return;
  }

  if (command === 'revoke') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    await revokeOidcClient(clientId, CLI_ACTOR);
    process.stdout.write(`Revoked ${clientId} and its existing grants and tokens.\n`);
    return;
  }

  if (command === 'rotate-secret') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    const secret = await rotateOidcClientSecret(clientId, CLI_ACTOR);
    process.stdout.write(`client_id=${clientId}\nclient_secret=${secret}\nCopy the new secret now; it is shown only once.\n`);
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof ClientValidationError) {
    process.stderr.write(`${USAGE}\n${error.issues.join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write('OIDC client operation failed. Check the command options and database state.\n');
  process.exitCode = 1;
});
