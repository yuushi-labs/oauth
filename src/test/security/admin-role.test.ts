import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Phase 7.5（§50 / §51）: role 変更 API の認可・検証・最後の管理者ガード・監査を検証する。
 *
 * セッションと `findUserById` だけを差し替え、認可判定（role / TOTP）と DB 書込みは
 * 実装そのものを通す。`resolveAdminTarget` / `changeUserRole` / 監査記録は実 DB を使う。
 */

const appUrl = 'http://localhost:3000';

type Actor = { id: string; email: string; roleId: string; totpEnabled: boolean; reauthed: boolean };

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
import { POST as changeRoleRoute } from '@/app/api/admin/users/[id]/role/route';

const ADMIN_ID = newId('usr');
const NO2FA_ADMIN_ID = newId('usr');
const SUSPENDED_ADMIN_ID = newId('usr');
const TARGET_ID = newId('usr');
const createdUserIds = [ADMIN_ID, NO2FA_ADMIN_ID, SUSPENDED_ADMIN_ID, TARGET_ID];

async function seedUser(id: string, roleId: string, status = 'active'): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
     VALUES ($1, $2, $3, true, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET role_id = EXCLUDED.role_id, status = EXCLUDED.status, deleted_at = NULL`,
    [id, `p75_${id}`, `${id}@example.com`, await hashPassword('Phase75-Admin-Strong-2026!'), status, roleId],
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
  await seedUser(SUSPENDED_ADMIN_ID, ROLE_IDS.admin, 'suspended');
  await seedTotp(SUSPENDED_ADMIN_ID);
  await seedUser(TARGET_ID, DEFAULT_ROLE_ID);
});
afterAll(async () => {
  await getPool().query(
    'DELETE FROM admin_audit_logs WHERE actor_user_id = ANY($1::text[]) OR target_user_id = ANY($1::text[])',
    [createdUserIds],
  );
  await getPool().query('DELETE FROM security_events WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM totp WHERE user_id = ANY($1::text[])', [createdUserIds]);
  await getPool().query('DELETE FROM users WHERE id = ANY($1::text[])', [createdUserIds]);
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.actor = { id: ADMIN_ID, email: `${ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };
  await getPool().query(`UPDATE users SET role_id = $2, status = 'active', deleted_at = NULL WHERE id = $1`, [TARGET_ID, DEFAULT_ROLE_ID]);
  await getPool().query(`UPDATE users SET role_id = $2, status = 'active', deleted_at = NULL WHERE id = $1`, [ADMIN_ID, ROLE_IDS.admin]);
  await getPool().query(`UPDATE users SET role_id = $2, status = 'active', deleted_at = NULL WHERE id = $1`, [NO2FA_ADMIN_ID, ROLE_IDS.admin]);
  await getPool().query(`UPDATE users SET role_id = $2, status = 'suspended', deleted_at = NULL WHERE id = $1`, [SUSPENDED_ADMIN_ID, ROLE_IDS.admin]);
  await getPool().query('DELETE FROM admin_audit_logs WHERE actor_user_id = ANY($1::text[])', [createdUserIds]);
  const keys = [ADMIN_ID, NO2FA_ADMIN_ID, SUSPENDED_ADMIN_ID].map((id) => protectRateLimitKey(rateLimitKeys.adminUser(id)));
  await getPool().query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
});

afterEach(() => vi.clearAllMocks());

function request(body: unknown): NextRequest {
  const session = sessionFor(state.actor);
  return new NextRequest(`${appUrl}/api/admin/users/${TARGET_ID}/role`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: appUrl,
      'content-type': 'application/json',
      'user-agent': 'vitest',
      cookie: `auth_session=${session.sessionHash}`,
      'x-csrf-token': deriveCsrfToken(session),
    },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function targetRole(): Promise<string> {
  const { rows } = await getPool().query<{ role_id: string }>('SELECT role_id FROM users WHERE id = $1', [TARGET_ID]);
  return rows[0]!.role_id;
}

describe('Security - role change API authorization (§50 / §51)', () => {
  it('一般ユーザーは 403 FORBIDDEN で遮断される', async () => {
    state.actor = { id: TARGET_ID, email: `${TARGET_ID}@example.com`, roleId: DEFAULT_ROLE_ID, totpEnabled: false, reauthed: true };
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.admin }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('2FA 未設定の管理者は 403 ADMIN_2FA_REQUIRED で遮断される', async () => {
    state.actor = { id: NO2FA_ADMIN_ID, email: `${NO2FA_ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: false, reauthed: true };
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.admin }), ctx(TARGET_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('ADMIN_2FA_REQUIRED');
  });

  it('再認証が切れていると 401 REAUTH_REQUIRED になる', async () => {
    state.actor = { ...state.actor, reauthed: false };
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.admin }), ctx(TARGET_ID));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('REAUTH_REQUIRED');
  });
});

describe('Security - role change validation and guards', () => {
  it('★ 一般ユーザーを管理者へ昇格でき、DB と監査ログに反映される', async () => {
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.admin }), ctx(TARGET_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).data.user.role_id).toBe(ROLE_IDS.admin);
    expect(await targetRole()).toBe(ROLE_IDS.admin);

    const { rows } = await getPool().query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM admin_audit_logs WHERE actor_user_id = $1 AND target_user_id = $2`,
      [ADMIN_ID, TARGET_ID],
    );
    expect(rows.map((r) => r.action)).toContain('admin_role_changed');
    const entry = rows.find((r) => r.action === 'admin_role_changed');
    expect(entry?.metadata).toMatchObject({ role: ROLE_IDS.admin, previous_role: DEFAULT_ROLE_ID });

    const { rows: events } = await getPool().query<{ event_type: string }>(
      `SELECT event_type FROM security_events WHERE user_id = $1`,
      [TARGET_ID],
    );
    expect(events.map((e) => e.event_type)).toContain('role_changed');
  });

  it('★ superadmin は API から付与できない（400・D-36-01）', async () => {
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.superadmin }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
    expect(await targetRole()).toBe(DEFAULT_ROLE_ID);
  });

  it('未知の role は 400 になる', async () => {
    const res = await changeRoleRoute(request({ role_id: 'role_unknown' }), ctx(TARGET_ID));
    expect(res.status).toBe(400);
  });

  it('自分自身の role は変更できない（409 CANNOT_TARGET_SELF・D-36-02）', async () => {
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.user }), ctx(ADMIN_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANNOT_TARGET_SELF');
  });

  it('存在しないユーザーは 404 ADMIN_NOT_FOUND になる', async () => {
    const missing = newId('usr');
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.admin }), ctx(missing));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('ADMIN_NOT_FOUND');
  });

  it('★ 最後の有効な管理者は降格できない（409 LAST_ADMIN・D-36-03）', async () => {
    // 有効な管理者は ADMIN_ID のみ（NO2FA は 2FA 無しでも「有効」、SUSPENDED は停止中）。
    // actor を停止中の管理者にして、ガードの人数計算が actor を含めないことを確かめる。
    await getPool().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [NO2FA_ADMIN_ID]);
    state.actor = { id: SUSPENDED_ADMIN_ID, email: `${SUSPENDED_ADMIN_ID}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };

    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.user }), ctx(ADMIN_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LAST_ADMIN');

    // ADMIN_ID は依然として管理者のまま
    const { rows } = await getPool().query<{ role_id: string }>('SELECT role_id FROM users WHERE id = $1', [ADMIN_ID]);
    expect(rows[0]!.role_id).toBe(ROLE_IDS.admin);
  });

  it('他に有効な管理者がいれば降格できる（LAST_ADMIN の誤発火を防ぐ）', async () => {
    const OTHER_ADMIN = newId('usr');
    await seedUser(OTHER_ADMIN, ROLE_IDS.admin);
    await seedTotp(OTHER_ADMIN);
    createdUserIds.push(OTHER_ADMIN);
    state.actor = { id: OTHER_ADMIN, email: `${OTHER_ADMIN}@example.com`, roleId: ROLE_IDS.admin, totpEnabled: true, reauthed: true };

    // この時点で有効な管理者は ADMIN_ID・NO2FA_ADMIN_ID・OTHER_ADMIN の 3 人
    const res = await changeRoleRoute(request({ role_id: ROLE_IDS.user }), ctx(ADMIN_ID));
    expect(res.status).toBe(200);
    const { rows } = await getPool().query<{ role_id: string }>('SELECT role_id FROM users WHERE id = $1', [ADMIN_ID]);
    expect(rows[0]!.role_id).toBe(ROLE_IDS.user);
  });
});
