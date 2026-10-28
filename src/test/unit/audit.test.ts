import { describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  values: vi.fn(async (_row: Record<string, unknown>) => undefined),
  // lookupUsername の `select(...).from(...).where(...).limit(1)` を解決する。
  select: vi.fn(() => ({
    from: () => ({
      where: () => ({ limit: async () => [{ username: 'looked_up' }] }),
    }),
  })),
}));
vi.mock('@/lib/db/client', () => ({
  getDb: () => ({ insert: () => ({ values: dbMock.values }), select: dbMock.select }),
}));

import { recordAdminAudit } from '@/lib/auth/audit';

const base = {
  actorUserId: 'usr_admin',
  actorUsername: 'admin',
  ip: '203.0.113.42',
  userAgent: 'vitest',
};

describe('recordAdminAudit', () => {
  it('aud_ prefix の ID と masked IP を保存する', async () => {
    dbMock.values.mockClear();
    await recordAdminAudit({ ...base, action: 'admin_user_viewed', metadata: { count: 3 } });
    expect(dbMock.values).toHaveBeenCalledTimes(1);
    const row = dbMock.values.mock.calls[0]![0];
    expect(String(row.id)).toMatch(/^aud_/);
    expect(row.action).toBe('admin_user_viewed');
    expect(row.actorUserId).toBe('usr_admin');
    expect(row.actorUsername).toBe('admin');
    expect(row.ip).toBe('203.0.113.42');
    expect(row.ipMasked).toBe('203.0.113.xxx');
    expect(row.metadata).toEqual({ count: 3 });
  });

  it('actorUsername 未指定なら DB から解決してスナップショットする', async () => {
    dbMock.values.mockClear();
    await recordAdminAudit({ action: 'admin_user_viewed', actorUserId: 'usr_admin', ip: '203.0.113.42', userAgent: 'vitest' });
    const row = dbMock.values.mock.calls[0]![0];
    expect(row.actorUsername).toBe('looked_up');
  });

  it('metadata は許可キーだけを残す（§45）', async () => {
    dbMock.values.mockClear();
    await recordAdminAudit({
      ...base,
      action: 'admin_user_suspended',
      targetUserId: 'usr_target',
      metadata: {
        status: 'suspended',
        reason: 'abuse',
        count: 1,
        sessions: 2,
        // 許可外は落ちる
        passwordHash: 'secret-hash',
        secretEncrypted: 'secret',
        publicKey: 'cHVia2V5',
      },
    });
    const row = dbMock.values.mock.calls[0]![0];
    expect(row.metadata).toEqual({ status: 'suspended', reason: 'abuse', count: 1, sessions: 2 });
    expect(row.targetUserId).toBe('usr_target');
  });

  it('metadata が無ければ null を保存する', async () => {
    dbMock.values.mockClear();
    await recordAdminAudit({ ...base, action: 'admin_account_deleted' });
    const row = dbMock.values.mock.calls[0]![0];
    expect(row.metadata).toBeNull();
    expect(row.targetUserId).toBeNull();
  });

  it('DB 例外を握って throw しない（記録失敗で操作を巻き戻さない）', async () => {
    dbMock.values.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      recordAdminAudit({ ...base, action: 'admin_user_viewed' }),
    ).resolves.toBeUndefined();
  });
});
