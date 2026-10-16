// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, idHash } = vi.hoisted(() => ({
  query: vi.fn(),
  idHash: vi.fn((value: string) => `hash(${value})`),
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({ query }),
  getDb: () => ({}),
}));
vi.mock('@/lib/oidc/crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/oidc/crypto')>('@/lib/oidc/crypto');
  return { ...actual, oidcIdHash: idHash };
});

import { purgeOidcGrantArtifacts, revokeUserOidcGrants, revokeUserOidcGrantsForClient } from '@/lib/oidc/grants';

const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length });

describe('Security - OIDC grant revocation', () => {
  beforeEach(() => {
    query.mockReset();
    idHash.mockClear();
  });

  it('grant 失効時は token/code と grant 行を id ハッシュで物理削除する', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("model = ANY($1)")) {
        expect(idHash).toHaveBeenCalledWith('gra_1');
        return rows([]);
      }
      return rows([]);
    });

    await purgeOidcGrantArtifacts('gra_1');

    const statements = query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toContain('model = ANY($1)');
    expect(statements[1]).toContain("model = 'Grant'");
    expect(query.mock.calls[0]?.[1]?.[0]).toEqual(['AccessToken', 'AuthorizationCode']);
  });

  it('ユーザー単位の失効は対象ユーザー以外の grant を触らない', async () => {
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('WHERE user_id = $1 AND revoked_at IS NULL');
      return rows([{ id: 'gra_1', client_id: 'cli_1' }]);
    });
    query.mockImplementation(async () => rows([]));

    const clients = await revokeUserOidcGrants('usr_1');

    expect(query.mock.calls[0]?.[1]).toEqual(['usr_1']);
    expect(clients).toEqual(['cli_1']);
    const deletion = query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM oidc_artifacts'));
    expect(deletion).toHaveLength(2);
  });

  it('失効対象がない場合は成果物を触らない', async () => {
    query.mockImplementationOnce(async () => rows([]));

    expect(await revokeUserOidcGrantsForClient('cli_unknown')).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('client 失効は client_id 単位で grant を失効し件数を返す', async () => {
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('WHERE client_id = $1 AND revoked_at IS NULL');
      return rows([{ id: 'gra_1' }, { id: 'gra_2' }]);
    });
    query.mockImplementation(async () => rows([]));

    expect(await revokeUserOidcGrantsForClient('cli_1')).toBe(2);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM oidc_artifacts'))).toHaveLength(4);
  });
});