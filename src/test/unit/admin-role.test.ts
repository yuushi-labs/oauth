import { describe, expect, it } from 'vitest';
import { isAssignableRole } from '@/lib/auth/admin-role';
import { ROLE_IDS } from '@/lib/db/schema';
import { roleRank } from '@/lib/auth/admin-policy';

/**
 * Phase 7.5: role 付与の可否判定。
 *
 * API は `admin`（rank 2）を上限にして `superadmin` への昇格を塞ぐ（D-36-01）。
 * CLI は `superadmin`（rank 3）を上限にして全 role を扱える（D-36-06）。
 */
describe('Unit - isAssignableRole', () => {
  const adminMax = roleRank(ROLE_IDS.admin);
  const superMax = roleRank(ROLE_IDS.superadmin);

  it('API 上限（admin）では user / moderator / admin のみ許可する', () => {
    expect(isAssignableRole(ROLE_IDS.user, adminMax)).toBe(true);
    expect(isAssignableRole(ROLE_IDS.moderator, adminMax)).toBe(true);
    expect(isAssignableRole(ROLE_IDS.admin, adminMax)).toBe(true);
    expect(isAssignableRole(ROLE_IDS.superadmin, adminMax)).toBe(false);
  });

  it('CLI 上限（superadmin）では 4 role すべて許可する', () => {
    for (const roleId of Object.values(ROLE_IDS)) {
      expect(isAssignableRole(roleId, superMax)).toBe(true);
    }
  });

  it('未知の role は常に拒否する（fail closed）', () => {
    expect(isAssignableRole('role_unknown', adminMax)).toBe(false);
    expect(isAssignableRole('', superMax)).toBe(false);
  });
});
