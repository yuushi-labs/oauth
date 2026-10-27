import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Phase 7（§49 / §50 / §51 / §61）: 管理 API の認可・2FA 必須・自己ロックアウト防止・
 * 監査ログ・secret 非露出を検証する。
 *
 * セッションと `findUserById` だけを差し替え、認可判定（role / TOTP）と DB 書込みは
 * 実装そのものを通す。
 */

const appUrl = 'http://localhost:3000';

type Actor = {
  id: string;
  email: string;
  roleId: string;
  totpEnabled: boolean;
  reauthed: boolean;
};

const state: { actor: Actor } = {
  actor: { id: '', email: '', roleId: '', totpEnabled: true, reauthed: true },
};

const sessionFor = (actor: Actor) => ({
  id: `ses_${actor.id}`,
  userId: actor.id,
  sessionHash: `hash-${actor.id}`,
  csrfSecret: 'csrf-secret',
  userAgent: 'vitest',
  ip: '203.0.113.10',
  ipMasked: '203.0.113.xxx',
  ipHash: null,
  deviceName: 'vitest',
  reauthVerifiedAt: actor.reauthed ? new Date().toISOString() : null,
  totpPending: false,
});

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => sessionFor(state.actor)) };
});
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return {
    ...actual,
    findUserById: vi.fn(async (id: string) =>
      id === state.actor.id
        ? { id, email: state.actor.email, roleId: state.actor.roleId, username: 'actor' }
        : null,
    ),
  };
});

import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { getPool } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/password';
import { ROLE_IDS, DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { protectRateLimitKey, rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { GET as listUsers } from '@/app/api/admin/users/route';
import { GET as listAuditLogs } from '@/app/api/admin/audit-logs/route';
import { POST as suspendUserRoute } from '@/app/api/admin/users/[id]/suspend/route';
import { POST as unsuspendUserRoute } from '@/app/api/admin/users/[id]/unsuspend/route';
import { POST as revokeSessionsRoute } from '@/app/api/admin/users/[id]/sessions/revoke/route';
import { POST as deleteUserRoute } from '@/app/api/admin/users/[id]/delete/route';

const stamp = Date.now().toString(36);
const ADMIN_ID = newId('usr');
const NO2FA_ADMIN_ID = newId('usr');
const TARGET_ID = newId('usr');
const DELETED_ID = newId('usr');
const MISSING_ID = newId('usr');
const createdUserIds = [ADMIN_ID, NO2FA_ADMIN_ID, TARGET_ID, DELETED_ID];

async function seedUser(id: string, roleId: string, options: { deleted?: boolean } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id, deleted_at)
     VALUES ($1, $2, $3, true, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
    [
      id,
      `p7_${id}`,
      `${id}@example.com`,
      await hashPassword('Phase7-Admin-Strong-2026!'),
      options.deleted ? 'deleted' : 'active',
      roleId,
      options.deleted ? new Date() : null,
    ],
  );
}

async function seedTotp(userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO totp (user_id, secret_encrypted, enabled, confirmed_at)
     VALUES ($1, 'enc:seeded', true, now()) ON CONFLICT (user_id) DO UPDATE SET enabled = true`,
    [userId],
  );
}

beforeAll(async () => {
  await seedUser(ADMIN_ID, ROLE_IDS.admin);
  await seedTotp(ADMIN_ID);
  await seedUser(NO2FA_ADMIN_ID, ROLE_IDS.admin);
  await seedUser(TARGET_ID, DEFAULT_ROLE_ID);
  await seedUser(DELETED_ID, DEFAULT_ROLE_ID, { deleted: true });
});

afterAll(async () => {
  await getPool().query('DELETE FROM admin_audit_logs WHERE actor_user_id = ANY($1::text[]) OR target_user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM security_events WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM sessions WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM totp WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds]);
});

beforeEach(async () => {
  vi.clearAllMocks();
  // 対象ユーザーの状態をテストごとにリセットする
  await getPool().query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [TARGET_ID]);
  await getPool().query('DELETE FROM admin_audit_logs WHERE actor_user_id = $1', [ADMIN_ID]);
  // admin レート制限キーを消す（テスト間で同じ actor を共有するため）
  const keys = [ADMIN_ID, NO2FA_ADMIN_ID].map((id) => protectRateLimitKey(rateLimitKeys.adminUser(id)));
  await getPool().query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
});

afterEach(() => vi.clearAllMocks());

function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): NextRequest {
  const session = sessionFor(state.actor);
  return new NextRequest(`${appUrl}${path}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_session=${session.sessionHash}`,
      'x-csrf-token': deriveCsrfToken(session),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('Security - admin RBAC and 2FA requirement (§50 / §51)', () => {
  it('一般ユーザーは 403 FORBIDDEN で遮断される', async () => {
    state.actor = { id: TARGET_ID, email: `${TARGET_ID}@example.com`, roleId: DEFAULT_ROLE_ID, totpEnabled: false, reauthed: true };
    const res = await listUsers(request('/api/admin/users'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('2FA 未設定の管理者は 403 ADMIN_2FA_REQUIRED で遮断される', async () => {
    state.actor = { id: NO2FA_ADMIN_ID, email: `${NO2FA_ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: false, reauthed: true };
    const res = await listUsers(request('/api/admin/users'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('ADMIN_2FA_REQUIRED');
  });

  it('2FA 有効な管理者は 200 でアクセスできる', async () => {
    state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };
    const res = await listUsers(request('/api/admin/users'));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('再認証が切れていると 401 REAUTH_REQUIRED になる', async () => {
    state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: false };
    const res = await listUsers(request('/api/admin/users'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('REAUTH_REQUIRED');
  });

  it('★ 管理 API は secret 列を返さない（§45 / §51）', async () => {
    state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };
    const res = await listUsers(request('/api/admin/users'));
    const body = await res.json();
    for (const u of body.data.users) {
      expect(u).not.toHaveProperty('password_hash');
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('secret_encrypted');
      expect(u).not.toHaveProperty('secretEncrypted');
      expect(u).not.toHaveProperty('credential_id');
      expect(u).not.toHaveProperty('public_key');
      expect(u).toHaveProperty('has_password');
      expect(u).toHaveProperty('has_2fa');
      expect(u).toHaveProperty('passkey_count');
    }
  });

  it('★ 管理 API の応答マッピングに secret 列が現れない（静的な回帰防止・§45）', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/admin/users/route.ts'), 'utf8');
    for (const secret of ['passwordHash', 'secretEncrypted', 'publicKey', 'credentialId', 'sessionHash', 'csrfSecret']) {
      expect(source, `admin users route must not expose ${secret}`).not.toContain(secret);
    }
  });
});

describe('Security - admin operations and audit (§51 / §61)', () => {
  beforeEach(() => {
    state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };
  });

  it('suspend は status を suspended にし、監査ログを残す', async () => {
    const res = await suspendUserRoute(request(`/api/admin/users/${TARGET_ID}/suspend`, 'POST', {}), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query(`SELECT status FROM users WHERE id = $1`, [TARGET_ID]);
    expect(rows[0].status).toBe('suspended');

    const { rows: logs } = await getPool().query(
      `SELECT action, actor_user_id, target_user_id, ip_masked FROM admin_audit_logs
       WHERE actor_user_id = $1 AND target_user_id = $2`,
      [ADMIN_ID, TARGET_ID],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('admin_user_suspended');
    // Route Handler を直接叩くと `request.ip` が無いため、IP は `0.0.0.0` に落ちる
    expect(logs[0].ip_masked).toBe('0.0.0.xxx');
  });

  it('unsuspend は status を active に戻す', async () => {
    await getPool().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [TARGET_ID]);
    const res = await unsuspendUserRoute(request(`/api/admin/users/${TARGET_ID}/unsuspend`, 'POST', {}), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query(`SELECT status FROM users WHERE id = $1`, [TARGET_ID]);
    expect(rows[0].status).toBe('active');
  });

  it('sessions/revoke は対象の有効セッションを失効させる', async () => {
    await getPool().query(
      `INSERT INTO sessions (id, user_id, session_hash, csrf_secret, user_agent, expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, 's', 'ua', now() + interval '1 hour', now() + interval '1 day')`,
      [`ses_revoke_${stamp}`, TARGET_ID, `hash_revoke_${stamp}`],
    );
    const res = await revokeSessionsRoute(request(`/api/admin/users/${TARGET_ID}/sessions/revoke`, 'POST', {}), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query(`SELECT revoked_at, revoke_reason FROM sessions WHERE user_id = $1`, [TARGET_ID]);
    expect(rows.every((r: { revoked_at: Date | null }) => r.revoked_at !== null)).toBe(true);
    expect(rows[0].revoke_reason).toBe('admin_revoke');
  });

  it('★ 自分自身を対象にすると 409 CANNOT_TARGET_SELF になる（D-35-10）', async () => {
    const res = await suspendUserRoute(request(`/api/admin/users/${ADMIN_ID}/suspend`, 'POST', {}), ctx(ADMIN_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANNOT_TARGET_SELF');
    const { rows } = await getPool().query(`SELECT status FROM users WHERE id = $1`, [ADMIN_ID]);
    expect(rows[0].status).toBe('active');
  });

  it('存在しない / 論理削除済みユーザーは 404 ADMIN_NOT_FOUND に丸める（§49）', async () => {
    const missing = await suspendUserRoute(request(`/api/admin/users/${MISSING_ID}/suspend`, 'POST', {}), ctx(MISSING_ID));
    const deleted = await suspendUserRoute(request(`/api/admin/users/${DELETED_ID}/suspend`, 'POST', {}), ctx(DELETED_ID));
    expect(missing.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect((await missing.json()).error.code).toBe('ADMIN_NOT_FOUND');
    expect((await deleted.json()).error.code).toBe('ADMIN_NOT_FOUND');
  });

  it('delete は論理削除し、監査ログを残す', async () => {
    const res = await deleteUserRoute(request(`/api/admin/users/${TARGET_ID}/delete`, 'POST', {}), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query(`SELECT deleted_at, status FROM users WHERE id = $1`, [TARGET_ID]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].status).toBe('deleted');
  });
});

describe('Security - audit logs API (§61)', () => {
  beforeEach(() => {
    state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };
  });

  it('一般ユーザーは監査ログを閲覧できない（403）', async () => {
    state.actor = { id: TARGET_ID, email: `${TARGET_ID}@example.com`, roleId: DEFAULT_ROLE_ID, totpEnabled: false, reauthed: true };
    const res = await listAuditLogs(request('/api/admin/audit-logs'));
    expect(res.status).toBe(403);
  });

  it('管理者は監査ログを取得でき、no-store が付く', async () => {
    await suspendUserRoute(request(`/api/admin/users/${TARGET_ID}/suspend`, 'POST', {}), ctx(TARGET_ID));
    const res = await listAuditLogs(request('/api/admin/audit-logs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const entry = body.data.logs.find((l: { action: string }) => l.action === 'admin_user_suspended');
    expect(entry).toBeDefined();
    expect(entry.actor_username).toBeTruthy();
    expect(entry).not.toHaveProperty('ip');
    expect(entry).not.toHaveProperty('user_agent');
  });
});
