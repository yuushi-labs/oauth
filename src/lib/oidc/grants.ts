import { getPool } from '@/lib/db/client';
import { oidcIdHash } from '@/lib/oidc/crypto';

const TOKEN_MODELS = ['AccessToken', 'AuthorizationCode'] as const;

export async function purgeOidcGrantArtifacts(grantId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM oidc_artifacts WHERE model = ANY($1) AND grant_id_hash = $2`,
    [[...TOKEN_MODELS], oidcIdHash(grantId)],
  );
  await pool.query(`DELETE FROM oidc_artifacts WHERE model = 'Grant' AND id_hash = $1`, [oidcIdHash(grantId)]);
}

export async function revokeUserOidcGrants(userId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; client_id: string }>(
    `UPDATE oidc_user_grants SET revoked_at = now(), updated_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL
     RETURNING id, client_id`,
    [userId],
  );
  for (const grant of result.rows) {
    await purgeOidcGrantArtifacts(grant.id);
  }
  return result.rows.map((grant) => grant.client_id);
}

export async function revokeUserOidcGrantsForClient(clientId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE oidc_user_grants SET revoked_at = now(), updated_at = now()
     WHERE client_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [clientId],
  );
  for (const grant of result.rows) {
    await purgeOidcGrantArtifacts(grant.id);
  }
  return result.rowCount ?? 0;
}