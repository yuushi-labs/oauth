import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 7（§49 / §50・D-35-01 / D-35-02）: RBAC 判定がサーバー側のみで行われ、
 * リクエストの入力（request / headers）に依存しないことを検証する。
 *
 * 実 HTTP の 403 / 200 は `admin.test.ts` が実 DB でカバーする。ここでは
 * 「認可関数のシグネチャに request / headers が現れない」静的な性質を守る（回帰防止）。
 */

vi.mock('@/lib/db/client', () => ({ getDb: () => ({}) }));

import { requireRole, hasRoleAtLeast, isAdminRole, roleRank } from '@/lib/auth/admin-policy';
import { ROLE_IDS } from '@/lib/db/schema';
import { ApiError } from '@/lib/errors';

const ADMIN_POLICY = resolve(process.cwd(), 'src/lib/auth/admin-policy.ts');
const ADMIN_ROUTES = resolve(process.cwd(), 'src/app/api/admin');

describe('Security - RBAC is server-side only (§49 / §50)', () => {
  it('requireRole は一般ユーザーで FORBIDDEN を投げる', () => {
    expect(() => requireRole({ roleId: ROLE_IDS.user }, ROLE_IDS.admin)).toThrow(ApiError);
    try {
      requireRole({ roleId: ROLE_IDS.user }, ROLE_IDS.admin);
    } catch (error) {
      expect((error as ApiError).code).toBe('FORBIDDEN');
      expect((error as ApiError).status).toBe(403);
    }
  });

  it('requireRole は admin / superadmin を通す', () => {
    expect(() => requireRole({ roleId: ROLE_IDS.admin }, ROLE_IDS.admin)).not.toThrow();
    expect(() => requireRole({ roleId: ROLE_IDS.superadmin }, ROLE_IDS.admin)).not.toThrow();
  });

  it('★ requireRole / requireAdminAccess は request / headers を引数に取らない', () => {
    const source = readFileSync(ADMIN_POLICY, 'utf8');
    // シグネチャに Request / Headers / NextRequest が現れない
    expect(source).not.toMatch(/requireRole\s*\(\s*(request|headers|req)/i);
    expect(source).not.toMatch(/requireAdminAccess\s*\([^)]*request/i);
    expect(source).not.toMatch(/requireAdminAccess\s*\([^)]*headers/i);
    // 認可判定に使う入力は session 由来の user だけ
    expect(source).toMatch(/export function hasRoleAtLeast\(user: RoleRef/);
  });

  it('rank 判定は fail closed（未知 role は最下位）', () => {
    expect(roleRank('role_unknown')).toBe(-1);
    expect(isAdminRole('role_unknown')).toBe(false);
    expect(hasRoleAtLeast({ roleId: 'role_unknown' }, ROLE_IDS.user)).toBe(false);
  });
});

describe('Static - admin routes are guarded', () => {
  const routes = [
    'users/route.ts',
    'users/[id]/suspend/route.ts',
    'users/[id]/unsuspend/route.ts',
    'users/[id]/role/route.ts',
    'users/[id]/sessions/revoke/route.ts',
    'users/[id]/delete/route.ts',
    'audit-logs/route.ts',
  ];

  it('すべての管理 API が withAdminPipeline を通る（§8.4）', () => {
    for (const route of routes) {
      const source = readFileSync(resolve(ADMIN_ROUTES, route), 'utf8');
      expect(source, `${route} should use withAdminPipeline`).toContain('withAdminPipeline');
    }
  });
});

describe('Static - every login path applies the admin session TTL (§51 / D-35-03)', () => {
  // セッションを発行する 4 経路すべてが短命セッションを適用しないと、
  // 管理者が 30 日セッションを得る抜け道になる（回帰防止）。
  const loginRoutes = [
    'src/app/api/auth/login/route.ts',
    'src/app/api/auth/oauth/social-login/route.ts',
    'src/app/api/auth/oauth/[provider]/callback/route.ts',
    'src/app/api/auth/passkey/login/verify/route.ts',
  ];

  it('sessionMaxAgeSecondsForRole を全経路で使う', () => {
    for (const route of loginRoutes) {
      const source = readFileSync(resolve(process.cwd(), route), 'utf8');
      expect(source, `${route} should apply sessionMaxAgeSecondsForRole`).toContain('sessionMaxAgeSecondsForRole');
    }
  });
});
