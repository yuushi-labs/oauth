import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { getPool } from '@/lib/db/client';
import { hashClientSecret } from '@/lib/oidc/crypto';
import { revokeUserOidcGrantsForClient } from '@/lib/oidc/grants';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { hasDisallowedScope, isOidcClientType, parseOidcScopes } from '@/lib/oidc/scopes';

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

function validateRedirect(uri: string): string {
  const parsed = new URL(uri);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (!['https:', ...(process.env.NODE_ENV === 'production' ? [] : ['http:'])].includes(parsed.protocol)
    || (!local && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Unsafe redirect URI: ${uri}`);
  }
  return uri;
}

function validateOrigin(origin: string): string {
  const parsed = new URL(origin);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash
    || (!local && parsed.protocol !== 'https:') || (local && process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) {
    throw new Error(`Unsafe web origin: ${origin}`);
  }
  return origin;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const pool = getPool();
  if (command === 'add') {
    const name = option('--name')[0]?.trim();
    const operator = option('--operator')[0]?.trim();
    const clientType = option('--type')[0];
    const redirectUris = [...new Set(option('--redirect-uri').map(validateRedirect))];
    const requestedScopes = [...new Set((option('--scope')[0] ?? 'openid').split(',').map((scope) => scope.trim()).filter(Boolean))];
    const allowedScopes = parseOidcScopes(option('--scope')[0] ?? 'openid');
    const webOrigins = [...new Set(option('--web-origin').map(validateOrigin))];
    if (!name || name.length > 100 || !operator || operator.length > 100 || !isOidcClientType(clientType) || redirectUris.length === 0
      || !allowedScopes.includes('openid') || hasDisallowedScope(requestedScopes)) {
      process.stderr.write(USAGE);
      process.exitCode = 2;
      return;
    }
    if (clientType === 'confidential' && webOrigins.length) throw new Error('Confidential clients must not have browser CORS origins.');
    const clientId = `cli_${randomBytes(24).toString('base64url')}`;
    const secret = clientType === 'confidential' ? `sec_${randomBytes(32).toString('base64url')}` : null;
    await pool.query(
      `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7::text[], $8, $9)`,
      [clientId, name, operator, clientType, JSON.stringify(redirectUris), allowedScopes, webOrigins,
        clientType === 'public' ? 'none' : 'client_secret_basic', secret ? hashClientSecret(secret) : null],
    );
    await recordSecurityEvent('oidc_client_registered', null, '', '', { clientId, clientType, scopeCount: allowedScopes.length });
    process.stdout.write(`client_id=${clientId}\nclient_type=${clientType}\noperator=${operator}\nredirect_uris=${redirectUris.join(',')}\nscopes=${allowedScopes.join(' ')}\n`);
    if (secret) process.stdout.write(`client_secret=${secret}\n`);
    process.stdout.write('Copy the client secret now; only its HMAC is stored and it is shown only once.\n');
    return;
  }
  if (command === 'update') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    const current = await pool.query<{ name: string; operator: string; client_type: 'public' | 'confidential'; redirect_uris: string[]; allowed_scopes: string[]; web_origins: string[] }>(
      `SELECT name, operator, client_type, redirect_uris, allowed_scopes, web_origins FROM oauth_clients
       WHERE client_id = $1 AND active = true AND revoked_at IS NULL`, [clientId],
    );
    const client = current.rows[0];
    if (!client) throw new Error('Active client not found.');
    const name = option('--name')[0]?.trim() ?? client.name;
    const operator = option('--operator')[0]?.trim() ?? client.operator;
    const scopeOption = option('--scope')[0];
    const requestedScopes = scopeOption ? [...new Set(scopeOption.split(',').map((scope) => scope.trim()).filter(Boolean))] : [];
    const allowedScopes = scopeOption ? parseOidcScopes(scopeOption) : client.allowed_scopes;
    const redirectUris = [
      ...client.redirect_uris.filter((uri) => !option('--remove-redirect-uri').includes(uri)),
      ...option('--add-redirect-uri').map(validateRedirect),
    ];
    const webOrigins = option('--web-origin').length ? [...new Set(option('--web-origin').map(validateOrigin))] : client.web_origins;
    if (!name || name.length > 100 || !operator || operator.length > 100 || redirectUris.length === 0
      || !allowedScopes.includes('openid') || hasDisallowedScope(requestedScopes)
      || (client.client_type === 'confidential' && webOrigins.length > 0)) {
      process.stderr.write(USAGE);
      process.exitCode = 2;
      return;
    }
    const result = await pool.query(
      `UPDATE oauth_clients SET name = $2, operator = $3, redirect_uris = $4::jsonb, allowed_scopes = $5::text[], web_origins = $6::text[], updated_at = now()
       WHERE client_id = $1 AND active = true AND revoked_at IS NULL RETURNING client_id`,
      [clientId, name, operator, JSON.stringify([...new Set(redirectUris)]), allowedScopes, webOrigins],
    );
    if (!result.rowCount) throw new Error('Active client not found.');
    const scopeChanged = allowedScopes.join(' ') !== client.allowed_scopes.join(' ');
    await recordSecurityEvent('oidc_client_updated', null, '', '', { clientId, scopeChanged, redirectUriCount: redirectUris.length });
    process.stdout.write(`Updated ${clientId}. scopes=${allowedScopes.join(' ')}\n`);
    if (scopeChanged) {
      process.stdout.write('Scope changes apply to new authorizations; existing grants keep their granted scopes until users re-consent or revoke.\n');
    }
    return;
  }
  if (command === 'revoke') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    const grantRows = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM oidc_user_grants WHERE client_id = $1 AND revoked_at IS NULL`, [clientId],
    );
    const result = await pool.query(
      `UPDATE oauth_clients SET active = false, revoked_at = now(), updated_at = now()
       WHERE client_id = $1 AND active = true RETURNING client_id`, [clientId],
    );
    if (!result.rowCount) throw new Error('Active client not found.');
    await revokeUserOidcGrantsForClient(clientId);
    await recordSecurityEvent('oidc_client_revoked', null, '', '', { clientId, affectedGrantCount: grantRows.rowCount });
    process.stdout.write(`Revoked ${clientId} and its existing grants and tokens.\n`);
    return;
  }
  if (command === 'rotate-secret') {
    const clientId = option('--client-id')[0];
    if (!clientId) { process.stderr.write(USAGE); process.exitCode = 2; return; }
    const secret = `sec_${randomBytes(32).toString('base64url')}`;
    const result = await pool.query(
      `UPDATE oauth_clients SET secret_hash = $2, updated_at = now()
       WHERE client_id = $1 AND client_type = 'confidential' AND active = true AND revoked_at IS NULL
       RETURNING client_id`, [clientId, hashClientSecret(secret)],
    );
    if (!result.rowCount) throw new Error('Active confidential client not found.');
    await recordSecurityEvent('oidc_client_secret_rotated', null, '', '', { clientId });
    process.stdout.write(`client_id=${clientId}\nclient_secret=${secret}\nCopy the new secret now; it is shown only once.\n`);
    return;
  }
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

main().catch(() => {
  process.stderr.write('OIDC client operation failed. Check the command options and database state.\n');
  process.exitCode = 1;
});
