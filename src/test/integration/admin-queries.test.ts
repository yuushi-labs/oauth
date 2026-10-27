import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  adminAuditLogs,
  ROLE_IDS,
  securityEvents,
  totp,
  users,
  webauthnCredentials,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { newId } from '@/lib/util/id';
import {
  findAdminTarget,
  listAdminUsers,
  suspendUser,
  unsuspendUser,
} from '@/lib/db/queries/admin';
import { listAdminAuditLogs } from '@/lib/db/queries/audit-logs';

/**
 * §51 / §61: 管理クエリ層を実 DB で検証する。
 * 一覧が secret 列を選択しないこと、監査ログが admin_audit_logs のみを返すことを固定する。
 */

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(options: {
  roleId?: string;
  status?: string;
  emailVerified?: boolean;
  deleted?: boolean;
} = {}): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email: `${uniq('m')}@example.com`,
    emailVerified: options.emailVerified ?? true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: options.deleted ? 'deleted' : (options.status ?? 'active'),
    roleId: options.roleId ?? ROLE_IDS.user,
  });
  if (options.deleted) {
    await getDb().update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
  }
  createdUserIds.push(id);
  return id;
}

afterEach(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, id));
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.targetUserId, id));
    await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('listAdminUsers', () => {
  it('secret 列を選択せず、has_password / has_2fa / passkey_count を返す', async () => {
    const id = await makeUser();
    await getDb().insert(totp).values({
      userId: id,
      secretEncrypted: 'enc-secret',
      enabled: true,
      lastUsedCounter: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await getDb().insert(webauthnCredentials).values({
      id: newId('wac'),
      userId: id,
      credentialId: `cred-${uniq('c')}`,
      publicKey: 'cHVia2V5',
      signCount: 0,
      backedUp: false,
      createdAt: new Date(),
    });

    const { users: rows, total } = await listAdminUsers({ limit: 100, offset: 0 });
    const row = rows.find((entry) => entry.id === id);
    expect(row).toBeDefined();
    expect(total).toBeGreaterThanOrEqual(1);
    // 返すキーに secret が無い（§51 / §45）
    const keys = Object.keys(row!);
    for (const forbidden of ['passwordHash', 'secretEncrypted', 'publicKey', 'credentialId']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(row!.hasPassword).toBe(true);
    expect(row!.has2fa).toBe(true);
    expect(row!.passkeyCount).toBe(1);
    expect(row!.roleId).toBe(ROLE_IDS.user);
  });

  it('TOTP が無いユーザーは has_2fa=false / passkey_count=0', async () => {
    const id = await makeUser();
    const { users: rows } = await listAdminUsers({ limit: 100, offset: 0 });
    const row = rows.find((entry) => entry.id === id);
    expect(row!.has2fa).toBe(false);
    expect(row!.passkeyCount).toBe(0);
  });

  it('limit / offset が効く', async () => {
    await makeUser();
    await makeUser();
    const page = await listAdminUsers({ limit: 1, offset: 0 });
    expect(page.users).toHaveLength(1);
  });
});

describe('findAdminTarget', () => {
  it('論理削除済みのユーザーは返さない', async () => {
    const active = await makeUser();
    const deleted = await makeUser({ deleted: true });
    expect((await findAdminTarget(active))?.id).toBe(active);
    expect(await findAdminTarget(deleted)).toBeNull();
    expect(await findAdminTarget('usr_does_not_exist')).toBeNull();
  });
});

describe('suspendUser / unsuspendUser', () => {
  it('停止 → 再開（email 確認済みは active に戻る）', async () => {
    const id = await makeUser({ emailVerified: true });
    await suspendUser(id);
    let row = await findAdminTarget(id);
    expect(row?.status).toBe('suspended');

    await unsuspendUser(id);
    row = await findAdminTarget(id);
    expect(row?.status).toBe('active');
  });

  it('email 未確認のユーザーは再開で pending_email に戻る', async () => {
    const id = await makeUser({ emailVerified: false, status: 'pending_email' });
    await suspendUser(id);
    await unsuspendUser(id);
    const row = await findAdminTarget(id);
    expect(row?.status).toBe('pending_email');
  });
});

describe('listAdminAuditLogs', () => {
  it('admin_audit_logs のみを返す（security_events は含めない）', async () => {
    const actor = await makeUser({ roleId: ROLE_IDS.admin });
    const target = await makeUser();
    await getDb().insert(adminAuditLogs).values({
      id: newId('aud'),
      actorUserId: actor,
      action: 'admin_user_suspended',
      targetUserId: target,
      ip: '203.0.113.5',
      ipMasked: '203.0.113.xxx',
      userAgent: 'vitest',
      metadata: { status: 'suspended' },
      createdAt: new Date(),
    });
    // 通常ログは混ざらない
    await getDb().insert(securityEvents).values({
      id: `evt_${uniq('e')}`,
      userId: actor,
      eventType: 'login_success',
      createdAt: new Date(),
    });

    const { logs } = await listAdminAuditLogs({ limit: 50, offset: 0 });
    const mine = logs.filter((log) => log.actorUserId === actor);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.action).toBe('admin_user_suspended');
    expect(mine[0]!.targetUserId).toBe(target);
    expect(mine[0]!.ipMasked).toBe('203.0.113.xxx');
    // security_events のイベント種別が現れない
    expect(logs.some((log) => (log as Record<string, unknown>).eventType !== undefined)).toBe(false);
  });
});
