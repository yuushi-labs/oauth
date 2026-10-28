import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/client';
import { PostgresOidcAdapter } from '@/lib/oidc/adapter';
import { consumeOAuthState, issueOAuthState } from '@/lib/auth/oauth/state';
import { sha256Hex } from '@/lib/util/crypto';
import { getDb } from '@/lib/db/client';
import { oauthStates } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

/**
 * §48「OAuth replay」カテゴリの正規テスト（D-38-05）。
 *
 * 認可コード / state の「1 回限り」は **単文 UPDATE ... WHERE 未消費** の更新行数で
 * 消費する（D-16）。read → 判定 → write の 2 段書きではないため、並行交換でも成功は
 * 1 件だけになる。ここでは実 PostgreSQL に対してそれを固定する。
 */

const issuedCodes: string[] = [];
const issuedStates: string[] = [];

afterAll(async () => {
  const pool = getPool();
  const { oidcIdHash } = await import('@/lib/oidc/crypto');
  if (issuedCodes.length) {
    await pool.query(
      `DELETE FROM oidc_artifacts WHERE model = 'AuthorizationCode' AND id_hash = ANY($1::text[])`,
      [issuedCodes.map((code) => oidcIdHash(code))],
    );
  }
  for (const state of issuedStates) {
    await getDb().delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }
});

describe('Security - OAuth authorization code replay (§48 / D-16)', () => {
  it('認可コードは 1 回だけ消費でき、2 回目は失敗する', async () => {
    const adapter = new PostgresOidcAdapter('AuthorizationCode');
    const code = `code-${Date.now().toString(36)}-a`;
    issuedCodes.push(code);
    await adapter.upsert(code, { clientId: 'cli_x', grantId: 'gra_x', consumed: undefined }, 600);

    // 1 回目の consume は成功する。
    await expect(adapter.consume(code)).resolves.toBeUndefined();
    // 2 回目は「消費済み or 期限切れ」として失敗する。
    await expect(adapter.consume(code)).rejects.toThrow();
  });

  it('★ 並行交換でも成功は 1 件だけ（単文 UPDATE の行数で消費）', async () => {
    const adapter = new PostgresOidcAdapter('AuthorizationCode');
    const code = `code-${Date.now().toString(36)}-b`;
    issuedCodes.push(code);
    await adapter.upsert(code, { clientId: 'cli_x', grantId: 'gra_x' }, 600);

    const results = await Promise.allSettled([
      adapter.consume(code),
      adapter.consume(code),
      adapter.consume(code),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('期限切れコードは consume できない', async () => {
    const adapter = new PostgresOidcAdapter('AuthorizationCode');
    const code = `code-${Date.now().toString(36)}-c`;
    issuedCodes.push(code);
    await adapter.upsert(code, { clientId: 'cli_x', grantId: 'gra_x' }, 1);
    // 期限を過去へ。
    await getPool().query(
      `UPDATE oidc_artifacts SET expires_at = now() - interval '1 second'
       WHERE model = 'AuthorizationCode' AND id_hash = $1`,
      [(await import('@/lib/oidc/crypto')).oidcIdHash(code)],
    );
    await expect(adapter.consume(code)).rejects.toThrow();
  });
});

describe('Security - OAuth state replay (§48)', () => {
  it('state は 1 回限りで、再利用は null になる', async () => {
    const issued = await issueOAuthState({ provider: 'github', intent: 'login' });
    issuedStates.push(issued.state);

    expect(await consumeOAuthState(issued.state, 'github')).not.toBeNull();
    expect(await consumeOAuthState(issued.state, 'github')).toBeNull();
  });

  it('並行消費でも成功は 1 件だけ', async () => {
    const issued = await issueOAuthState({ provider: 'google', intent: 'login' });
    issuedStates.push(issued.state);

    const results = await Promise.all([
      consumeOAuthState(issued.state, 'google'),
      consumeOAuthState(issued.state, 'google'),
      consumeOAuthState(issued.state, 'google'),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });
});
