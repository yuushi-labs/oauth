import { getPool } from '@/lib/db/client';
import { decryptOidcValue, encryptOidcValue, oidcIdHash } from '@/lib/oidc/crypto';

type OidcPayload = Record<string, unknown>;

const ACCOUNT_BOUND_MODELS = new Set(['AccessToken', 'AuthorizationCode', 'Grant', 'Session']);

/**
 * oidc-provider persistence adapter. Opaque artifact IDs are only stored as
 * HMACs; payloads (including code/token IDs and claims) are AES-256-GCM
 * encrypted before they reach PostgreSQL.
 */
export class PostgresOidcAdapter {
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async upsert(id: string, payload: OidcPayload, expiresIn: number): Promise<void> {
    const expirySeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.ceil(expiresIn) : 60;
    const pool = getPool();
    await pool.query(
      `INSERT INTO oidc_artifacts (model, id_hash, grant_id_hash, uid_hash, user_code_hash, payload_ciphertext, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'), $8)
       ON CONFLICT (model, id_hash) DO UPDATE SET
         grant_id_hash = EXCLUDED.grant_id_hash,
         uid_hash = EXCLUDED.uid_hash,
         user_code_hash = EXCLUDED.user_code_hash,
         payload_ciphertext = EXCLUDED.payload_ciphertext,
         expires_at = EXCLUDED.expires_at,
         consumed_at = EXCLUDED.consumed_at`,
      [this.model, oidcIdHash(id), typeof payload.grantId === 'string' ? oidcIdHash(payload.grantId) : null,
        typeof payload.uid === 'string' ? oidcIdHash(payload.uid) : null,
        typeof payload.userCode === 'string' ? oidcIdHash(payload.userCode) : null,
        encryptOidcValue(JSON.stringify(payload)), expirySeconds,
        typeof payload.consumed === 'number' ? new Date(payload.consumed * 1000) : null],
    );
  }

  async find(id: string): Promise<OidcPayload | undefined> {
    if (this.model === 'Client') return this.findClient(id);
    const pool = getPool();
    const result = await pool.query<{ payload_ciphertext: string; consumed_at: Date | null }>(
      `SELECT payload_ciphertext, consumed_at FROM oidc_artifacts
       WHERE model = $1 AND id_hash = $2 AND expires_at > now() LIMIT 1`,
      [this.model, oidcIdHash(id)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const payload = JSON.parse(decryptOidcValue(row.payload_ciphertext)) as OidcPayload;
    if (row.consumed_at) payload.consumed = Math.floor(row.consumed_at.getTime() / 1000);
    if (ACCOUNT_BOUND_MODELS.has(this.model) && typeof payload.accountId === 'string'
      && !(await this.accountIsUsable(payload.accountId))) return undefined;
    if (['AccessToken', 'AuthorizationCode'].includes(this.model)) {
      if (typeof payload.clientId === 'string') {
        const client = await pool.query(
          `SELECT 1 FROM oauth_clients WHERE client_id = $1 AND active = true AND revoked_at IS NULL`,
          [payload.clientId],
        );
        if (!client.rowCount) return undefined;
      }
      if (typeof payload.grantId === 'string') {
        const grant = await pool.query(
          `SELECT 1 FROM oidc_user_grants WHERE id = $1 AND revoked_at IS NULL`, [payload.grantId],
        );
        if (!grant.rowCount) return undefined;
      }
    }
    return payload;
  }

  async findByUserCode(userCode: string): Promise<OidcPayload | undefined> {
    return this.findByField('userCode', userCode);
  }

  async findByUid(uid: string): Promise<OidcPayload | undefined> {
    return this.findByField('uid', uid);
  }

  async consume(id: string): Promise<void> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE oidc_artifacts SET consumed_at = now()
       WHERE model = $1 AND id_hash = $2 AND expires_at > now() AND consumed_at IS NULL
       RETURNING id_hash`,
      [this.model, oidcIdHash(id)],
    );
    if (result.rowCount !== 1) throw new Error('OIDC artifact was already consumed or expired');
  }

  async destroy(id: string): Promise<void> {
    await getPool().query('DELETE FROM oidc_artifacts WHERE model = $1 AND id_hash = $2', [this.model, oidcIdHash(id)]);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await getPool().query('DELETE FROM oidc_artifacts WHERE model = $1 AND grant_id_hash = $2', [this.model, oidcIdHash(grantId)]);
  }

  private async accountIsUsable(accountId: string): Promise<boolean> {
    const result = await getPool().query(
      `SELECT 1 FROM users u
       LEFT JOIN oidc_user_subjects s ON s.user_id = u.id
       WHERE (u.id = $1 OR s.subject = $1)
         AND u.status = 'active' AND u.email_verified = true AND u.deleted_at IS NULL
       LIMIT 1`,
      [accountId],
    );
    return Boolean(result.rowCount);
  }

  private async findByField(field: 'uid' | 'userCode', value: string): Promise<OidcPayload | undefined> {
    const column = field === 'uid' ? 'uid_hash' : 'user_code_hash';
    const result = await getPool().query<{ payload_ciphertext: string }>(
      `SELECT payload_ciphertext FROM oidc_artifacts
       WHERE model = $1 AND ${column} = $2 AND expires_at > now() LIMIT 1`, [this.model, oidcIdHash(value)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const payload = JSON.parse(decryptOidcValue(row.payload_ciphertext)) as OidcPayload;
    return payload[field] === value ? payload : undefined;
  }

  private async findClient(clientId: string): Promise<OidcPayload | undefined> {
    const result = await getPool().query<{
      client_id: string;
      name: string;
      client_type: 'public' | 'confidential';
      redirect_uris: string[];
      allowed_scopes: string[];
      token_endpoint_auth_method: 'none' | 'client_secret_basic';
      secret_hash: string | null;
      active: boolean;
    }>(
      `SELECT client_id, name, client_type, redirect_uris, allowed_scopes,
              token_endpoint_auth_method, secret_hash, active FROM oauth_clients
       WHERE client_id = $1 AND active = true AND revoked_at IS NULL`,
      [clientId],
    );
    const client = result.rows[0];
    if (!client) return undefined;
    return {
      client_id: client.client_id,
      client_name: client.name,
      client_secret: client.secret_hash ?? undefined,
      redirect_uris: client.redirect_uris,
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: client.allowed_scopes.join(' '),
      id_token_signed_response_alg: 'RS256',
    };
  }
}
