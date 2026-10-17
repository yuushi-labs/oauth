import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { oauthClients, oidcUserGrants, users } from '@/lib/db/schema';
import { hashClientSecret } from '@/lib/oidc/crypto';
import { revokeUserOidcGrantsForClient } from '@/lib/oidc/grants';
import {
  ClientValidationError,
  parseClientInput,
  parseClientUpdateInput,
  requireWebOriginForPublicClient,
  type ClientInput,
} from '@/lib/oidc/client-validation';
import { isOidcClientPrivilegedRole } from '@/lib/auth/roles';
import type { OidcClientType } from '@/lib/oidc/scopes';

export const OIDC_CLIENT_ID_PREFIX = 'cli_';
export const OIDC_CLIENT_SECRET_PREFIX = 'sec_';

export type OidcClientOwner = { id: string; roleId: string };

/**
 * `trustedOperator` is only set by the server-side CLI, where the operator already has database
 * access. Console requests never set it, so ownership is always enforced for them.
 */
export type OidcClientActor = { userId: string | null; ip: string; userAgent: string; trustedOperator?: boolean };

export type CreatedOidcClient = {
  clientId: string;
  clientSecret: string | null;
};

export type OidcClientListItem = {
  clientId: string;
  name: string;
  operator: string;
  clientType: string;
  redirectUris: string[];
  allowedScopes: string[];
  webOrigins: string[];
  active: boolean;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUsername: string | null;
  grantCount: number;
  lastUsedAt: string | null;
  isOwner: boolean;
};

export class OidcClientLimitError extends Error {
  constructor(limit: number) {
    super(`client の上限（${limit} 件）に達しています`);
    this.name = 'OidcClientLimitError';
  }
}

export class OidcClientNotFoundError extends Error {
  constructor() {
    super('client が見つかりません');
    this.name = 'OidcClientNotFoundError';
  }
}

export class OidcClientForbiddenError extends Error {
  constructor() {
    super('この client を操作する権限がありません');
    this.name = 'OidcClientForbiddenError';
  }
}

function generateClientId(): string {
  return `${OIDC_CLIENT_ID_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function generateClientSecret(): string {
  return `${OIDC_CLIENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function countOwnedClients(ownerUserId: string): Promise<number> {
  const db = getDb();
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(oauthClients)
    .where(eq(oauthClients.ownerUserId, ownerUserId))
    .then((rows) => rows[0]?.count ?? 0);
}

export async function createOidcClient(
  input: ClientInput,
  actor: OidcClientActor,
  options: { maxClientsPerUser?: number; enforceWebOrigin?: boolean } = {},
): Promise<CreatedOidcClient> {
  const limit = options.maxClientsPerUser;
  if (actor.userId && typeof limit === 'number' && limit > 0) {
    const owned = await countOwnedClients(actor.userId);
    if (owned >= limit) throw new OidcClientLimitError(limit);
  }

  const clientId = generateClientId();
  const secret = input.clientType === 'confidential' ? generateClientSecret() : null;
  const pool = getPool();
  await pool.query(
    `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash, owner_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7::text[], $8, $9, $10)`,
    [clientId, input.name, input.operator, input.clientType, JSON.stringify(input.redirectUris), input.scopes, input.webOrigins,
      input.clientType === 'public' ? 'none' : 'client_secret_basic', secret ? hashClientSecret(secret) : null, actor.userId],
  );

  await recordClientEvent('oidc_client_registered', clientId, actor, {
    clientType: input.clientType,
    scopeCount: input.scopes.length,
    redirectUriCount: input.redirectUris.length,
    via: actor.userId ? 'console' : 'cli',
  });

  return { clientId, clientSecret: secret };
}

export async function updateOidcClient(
  clientId: string,
  rawInput: unknown,
  actor: OidcClientActor,
): Promise<void> {
  const current = await requireManageableClient(clientId, actor.userId, { trustedOperator: actor.trustedOperator });
  const input = parseClientUpdateInput(rawInput, current.clientType as OidcClientType);

  const pool = getPool();
  const result = await pool.query(
    `UPDATE oauth_clients SET name = $2, operator = $3, redirect_uris = $4::jsonb, allowed_scopes = $5::text[], web_origins = $6::text[], updated_at = now()
     WHERE client_id = $1 AND active = true AND revoked_at IS NULL RETURNING client_id`,
    [clientId, input.name, input.operator, JSON.stringify(input.redirectUris), input.scopes, input.webOrigins],
  );
  if (!result.rowCount) throw new OidcClientNotFoundError();

  await recordClientEvent('oidc_client_updated', clientId, actor, {
    scopeChanged: input.scopes.join(' ') !== current.allowedScopes.join(' '),
    redirectUriCount: input.redirectUris.length,
  });
}

export async function rotateOidcClientSecret(
  clientId: string,
  actor: OidcClientActor,
): Promise<string> {
  await requireManageableClient(clientId, actor.userId, { trustedOperator: actor.trustedOperator });
  const secret = generateClientSecret();
  const result = await getPool().query(
    `UPDATE oauth_clients SET secret_hash = $2, updated_at = now()
     WHERE client_id = $1 AND client_type = 'confidential' AND active = true AND revoked_at IS NULL
     RETURNING client_id`,
    [clientId, hashClientSecret(secret)],
  );
  if (!result.rowCount) throw new OidcClientNotFoundError();
  await recordClientEvent('oidc_client_secret_rotated', clientId, actor, {});
  return secret;
}

export async function revokeOidcClient(
  clientId: string,
  actor: OidcClientActor,
): Promise<number> {
  await requireManageableClient(clientId, actor.userId, { trustedOperator: actor.trustedOperator });
  const grantRows = await getPool().query<{ id: string }>(
    `SELECT id FROM oidc_user_grants WHERE client_id = $1 AND revoked_at IS NULL`, [clientId],
  );
  const result = await getPool().query(
    `UPDATE oauth_clients SET active = false, revoked_at = now(), updated_at = now()
     WHERE client_id = $1 AND active = true RETURNING client_id`, [clientId],
  );
  if (!result.rowCount) throw new OidcClientNotFoundError();
  await revokeUserOidcGrantsForClient(clientId);
  await recordClientEvent('oidc_client_revoked', clientId, actor, { affectedGrantCount: grantRows.rowCount ?? 0 });
  return grantRows.rowCount ?? 0;
}

export async function requireManageableClient(
  clientId: string,
  actorUserId: string | null,
  options: { trustedOperator?: boolean } = {},
): Promise<{ clientId: string; clientType: string; allowedScopes: string[]; redirectUris: string[]; ownerUserId: string | null }> {
  const result = await getPool().query<{
    client_type: string;
    allowed_scopes: string[];
    redirect_uris: string[];
    owner_user_id: string | null;
  }>(
    `SELECT client_type, allowed_scopes, redirect_uris, owner_user_id FROM oauth_clients
     WHERE client_id = $1 AND active = true AND revoked_at IS NULL`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) throw new OidcClientNotFoundError();
  if (options.trustedOperator) {
    return { clientId, clientType: row.client_type, allowedScopes: row.allowed_scopes, redirectUris: row.redirect_uris, ownerUserId: row.owner_user_id };
  }
  if (row.owner_user_id && actorUserId && row.owner_user_id === actorUserId) {
    return { clientId, clientType: row.client_type, allowedScopes: row.allowed_scopes, redirectUris: row.redirect_uris, ownerUserId: row.owner_user_id };
  }
  if (actorUserId) {
    const owner = await getDb().select({ roleId: users.roleId }).from(users).where(eq(users.id, actorUserId)).limit(1);
    if (isOidcClientPrivilegedRole(owner[0]?.roleId ?? '')) {
      return { clientId, clientType: row.client_type, allowedScopes: row.allowed_scopes, redirectUris: row.redirect_uris, ownerUserId: row.owner_user_id };
    }
  }
  throw new OidcClientForbiddenError();
}

export async function listOidcClients(viewer: { id: string; roleId: string }): Promise<OidcClientListItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      operator: oauthClients.operator,
      clientType: oauthClients.clientType,
      redirectUris: oauthClients.redirectUris,
      allowedScopes: oauthClients.allowedScopes,
      webOrigins: oauthClients.webOrigins,
      active: oauthClients.active,
      revokedAt: oauthClients.revokedAt,
      createdAt: oauthClients.createdAt,
      updatedAt: oauthClients.updatedAt,
      ownerUserId: oauthClients.ownerUserId,
      ownerUsername: users.username,
      grantCount: sql<number>`(SELECT count(*)::int FROM ${oidcUserGrants}
         WHERE ${oidcUserGrants.clientId} = ${oauthClients.clientId} AND ${oidcUserGrants.revokedAt} IS NULL)`,
      lastUsedAt: sql<Date | null>`(SELECT max(${oidcUserGrants.lastUsedAt}) FROM ${oidcUserGrants}
         WHERE ${oidcUserGrants.clientId} = ${oauthClients.clientId} AND ${oidcUserGrants.revokedAt} IS NULL)`,
    })
    .from(oauthClients)
    .leftJoin(users, eq(oauthClients.ownerUserId, users.id))
    .where(isOidcClientPrivilegedRole(viewer.roleId) ? undefined : eq(oauthClients.ownerUserId, viewer.id))
    .orderBy(desc(oauthClients.createdAt));

  return rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    operator: row.operator,
    clientType: row.clientType,
    redirectUris: row.redirectUris,
    allowedScopes: row.allowedScopes,
    webOrigins: row.webOrigins,
    active: row.active,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ownerUsername: row.ownerUsername,
    grantCount: Number(row.grantCount ?? 0),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    isOwner: row.ownerUserId === viewer.id,
  }));
}

export async function findOidcClient(clientId: string): Promise<{
  clientId: string;
  name: string;
  operator: string;
  clientType: string;
  createdAt: string;
  redirectUris: string[];
  allowedScopes: string[];
  webOrigins: string[];
  active: boolean;
  ownerUsername: string | null;
  ownerCreatedAt: string | null;
} | null> {
  const rows = await getDb()
    .select({
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      operator: oauthClients.operator,
      clientType: oauthClients.clientType,
      createdAt: oauthClients.createdAt,
      redirectUris: oauthClients.redirectUris,
      allowedScopes: oauthClients.allowedScopes,
      webOrigins: oauthClients.webOrigins,
      active: oauthClients.active,
      ownerUsername: users.username,
      ownerCreatedAt: users.createdAt,
    })
    .from(oauthClients)
    .leftJoin(users, eq(oauthClients.ownerUserId, users.id))
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.clientId,
    name: row.name,
    operator: row.operator,
    clientType: row.clientType,
    createdAt: row.createdAt.toISOString(),
    redirectUris: row.redirectUris,
    allowedScopes: row.allowedScopes,
    webOrigins: row.webOrigins,
    active: row.active,
    ownerUsername: row.ownerUsername,
    ownerCreatedAt: row.ownerCreatedAt?.toISOString() ?? null,
  };
}

export async function countActiveGrantsForClient(clientId: string): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(oidcUserGrants)
    .where(and(eq(oidcUserGrants.clientId, clientId), isNull(oidcUserGrants.revokedAt)));
  return rows[0]?.count ?? 0;
}

async function recordClientEvent(
  type: 'oidc_client_registered' | 'oidc_client_updated' | 'oidc_client_revoked' | 'oidc_client_secret_rotated',
  clientId: string,
  actor: OidcClientActor,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { recordSecurityEvent } = await import('@/lib/auth/security-events');
  await recordSecurityEvent(type, actor.userId, actor.ip, actor.userAgent, { clientId, ...metadata });
}

export { ClientValidationError, parseClientInput, parseClientUpdateInput, requireWebOriginForPublicClient };
