import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 7（§61・D-35-07）: 監査ログへの記録と、閲覧の遮断を検証する。
 *
 * 1. 5 アクション（view / suspend / unsuspend / session revoke / delete）が `admin_audit_logs` に入る
 * 2. `security_events` とは混ざらない
 * 3. 一般ユーザーは読めない（403）
 * 4. `listAdminAuditLogs` が管理 API 以外から import されていない（静的検査）
 */

const appUrl = 'http://localhost:3000';

const state: { roleId: string; id: string } = { roleId: '', id: '' };

const sessionFor = () => ({
  id: `ses_${state.id}`,
  userId: state.id,
  sessionHash: `hash-${state.id}`,
  csrfSecret: 'csrf-secret',
  userAgent: 'vitest',
  ip: '203.0.113.10',
  ipMasked: '203.0.113.xxx',
  ipHash: null,
  deviceName: 'vitest',
  reauthVerifiedAt: new Date().toISOString(),
  totpPending: false,
});

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => sessionFor()) };
});
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return {
    ...actual,
    findUserById: vi.fn(async (id: string) =>
      id === state.id ? { id, email: `${id}@example.com`, roleId: state.roleId, username: 'actor' } : null,
    ),
  };
});

import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { getPool } from '@/lib/db/client';
import { hashPassword } from '@/lib/auth/password';
import { ROLE_IDS, DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { newId } from '@/lib/util/id';
import { protectRateLimitKey, rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { GET as listAuditLogs } from '@/app/api/admin/audit-logs/route';
import { GET as listUsers } from '@/app/api/admin/users/route';
import { POST as suspendUserRoute } from '@/app/api/admin/users/[id]/suspend/route';
import { POST as unsuspendUserRoute } from '@/app/api/admin/users/[id]/unsuspend/route';
import { POST as revokeSessionsRoute } from '@/app/api/admin/users/[id]/sessions/revoke/route';
import { POST as deleteUserRoute } from '@/app/api/admin/users/[id]/delete/route';

const ADMIN_ID = newId('usr');
const TARGET_ID = newId('usr');
const createdUserIds = [ADMIN_ID, TARGET_ID];

afterAll(async () => {
  await getPool().query('DELETE FROM admin_audit_logs WHERE actor_user_id = ANY($1::text[]) OR target_user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM security_events WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM sessions WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM totp WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds]);
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.id = ADMIN_ID;
  state.roleId = ROLE_IDS.admin;
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, `audit_admin_${ADMIN_ID}`, `${ADMIN_ID}@example.com`, await hashPassword('Audit-Admin-Strong-2026!'), ROLE_IDS.admin],
  );
  await getPool().query(
    `INSERT INTO totp (user_id, secret_encrypted, enabled, confirmed_at)
     VALUES ($1, 'enc:seeded', true, now()) ON CONFLICT (user_id) DO UPDATE SET enabled = true`,
    [ADMIN_ID],
  );
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, 'active', $5) ON CONFLICT (id) DO UPDATE SET status = 'active', deleted_at = NULL`,
    [TARGET_ID, `audit_target_${TARGET_ID}`, `${TARGET_ID}@example.com`, await hashPassword('Audit-Target-Strong-2026!'), DEFAULT_ROLE_ID],
  );
  await getPool().query('DELETE FROM admin_audit_logs WHERE actor_user_id = $1', [ADMIN_ID]);
  const keys = [ADMIN_ID].map((id) => protectRateLimitKey(rateLimitKeys.adminUser(id)));
  await getPool().query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
});

function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): NextRequest {
  const session = sessionFor();
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

describe('Security - audit log recording (§61)', () => {
  it('★ 5 アクションが admin_audit_logs に記録される', async () => {
    await listUsers(request('/api/admin/users'));
    await suspendUserRoute(request(`/api/admin/users/${TARGET_ID}/suspend`, 'POST', {}), ctx(TARGET_ID));
    await unsuspendUserRoute(request(`/api/admin/users/${TARGET_ID}/unsuspend`, 'POST', {}), ctx(TARGET_ID));
    await revokeSessionsRoute(request(`/api/admin/users/${TARGET_ID}/sessions/revoke`, 'POST', {}), ctx(TARGET_ID));
    await deleteUserRoute(request(`/api/admin/users/${TARGET_ID}/delete`, 'POST', {}), ctx(TARGET_ID));

    const { rows } = await getPool().query(
      `SELECT action FROM admin_audit_logs WHERE actor_user_id = $1`,
      [ADMIN_ID],
    );
    const actions = rows.map((r: { action: string }) => r.action).sort();
    expect(actions).toEqual([
      'admin_account_deleted',
      'admin_session_revoked',
      'admin_user_suspended',
      'admin_user_unsuspended',
      'admin_user_viewed',
    ]);
  });

  it('★ 監査ログは security_events と混ざらない（D-35-07）', async () => {
    await suspendUserRoute(request(`/api/admin/users/${TARGET_ID}/suspend`, 'POST', {}), ctx(TARGET_ID));

    const { rows: auditRows } = await getPool().query(
      `SELECT action FROM admin_audit_logs WHERE actor_user_id = $1`,
      [ADMIN_ID],
    );
    expect(auditRows.map((r: { action: string }) => r.action)).toContain('admin_user_suspended');

    // security_events 側には admin_user_suspended が存在しない（別テーブル・別語彙）
    const { rows: secRows } = await getPool().query(
      `SELECT event_type FROM security_events WHERE event_type = 'admin_user_suspended'`,
    );
    expect(secRows).toHaveLength(0);
  });
});

describe('Security - audit log access control (§61 / §49)', () => {
  it('★ 一般ユーザーは監査ログを閲覧できない（403）', async () => {
    state.id = TARGET_ID;
    state.roleId = DEFAULT_ROLE_ID;
    const res = await listAuditLogs(request('/api/admin/audit-logs'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('管理者は 200・no-store・secret を含まない', async () => {
    await suspendUserRoute(request(`/api/admin/users/${TARGET_ID}/suspend`, 'POST', {}), ctx(TARGET_ID));
    const res = await listAuditLogs(request('/api/admin/audit-logs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/password_hash|secret_encrypted|public_key|credential_id/);
    const entry = body.data.logs.find((l: { action: string }) => l.action === 'admin_user_suspended');
    expect(entry).toBeDefined();
    expect(entry.actor_username).toBeTruthy();
    expect(entry).not.toHaveProperty('ip');
    expect(entry).not.toHaveProperty('user_agent');
  });
});

describe('Static - audit query isolation', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
    return files;
  }

  it('listAdminAuditLogs は admin 画面 / 管理 API 以外から import されない', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('queries/audit-logs.ts')) continue;
      const normalized = file.replace(/\\/g, '/');
      // テストは検証のために import してよい（実装からの誤用だけを検出する）
      if (normalized.includes('/src/test/')) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('listAdminAuditLogs')) continue;
      // 管理 API（withAdminPipeline）と管理画面（requireAdminUser でガード）のみ許可する。
      const guarded = normalized.includes('/api/admin/') || normalized.includes('/app/admin/');
      if (!guarded) violations.push(normalized.replace(SRC, 'src'));
    }
    expect(violations).toEqual([]);
  });
});
