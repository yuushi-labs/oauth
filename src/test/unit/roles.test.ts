import { describe, expect, it } from 'vitest';
import { canManageAnyOidcClient, isOidcClientPrivilegedRole } from '@/lib/auth/roles';
import { hasRoleAtLeast, isAdminRole, roleRank } from '@/lib/auth/admin-policy';
import { ROLE_IDS } from '@/lib/db/schema';

describe('OIDC client roles', () => {
  it('grants console-wide management only to admin and superadmin', () => {
    expect(canManageAnyOidcClient({ roleId: ROLE_IDS.admin })).toBe(true);
    expect(canManageAnyOidcClient({ roleId: ROLE_IDS.superadmin })).toBe(true);
    expect(canManageAnyOidcClient({ roleId: ROLE_IDS.moderator })).toBe(false);
    expect(canManageAnyOidcClient({ roleId: ROLE_IDS.user })).toBe(false);
    expect(canManageAnyOidcClient(null)).toBe(false);
    expect(canManageAnyOidcClient(undefined)).toBe(false);
  });

  it('never treats a regular user role as privileged', () => {
    expect(isOidcClientPrivilegedRole(ROLE_IDS.user)).toBe(false);
    expect(isOidcClientPrivilegedRole('')).toBe(false);
    expect(isOidcClientPrivilegedRole('role_admin')).toBe(true);
  });
});

describe('RBAC role rank (§50 / D-35-01)', () => {
  it('rank は user=0 / moderator=1 / admin=2 / superadmin=3、未知は -1（fail closed）', () => {
    expect(roleRank(ROLE_IDS.user)).toBe(0);
    expect(roleRank(ROLE_IDS.moderator)).toBe(1);
    expect(roleRank(ROLE_IDS.admin)).toBe(2);
    expect(roleRank(ROLE_IDS.superadmin)).toBe(3);
    expect(roleRank('role_unknown')).toBe(-1);
  });

  it('isAdminRole は admin / superadmin のみ true', () => {
    expect(isAdminRole(ROLE_IDS.admin)).toBe(true);
    expect(isAdminRole(ROLE_IDS.superadmin)).toBe(true);
    expect(isAdminRole(ROLE_IDS.moderator)).toBe(false);
    expect(isAdminRole(ROLE_IDS.user)).toBe(false);
    expect(isAdminRole('role_unknown')).toBe(false);
  });

  it('hasRoleAtLeast は rank の境界で判定する', () => {
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.user }, ROLE_IDS.admin)).toBe(false);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.moderator }, ROLE_IDS.admin)).toBe(false);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.admin }, ROLE_IDS.admin)).toBe(true);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.superadmin }, ROLE_IDS.admin)).toBe(true);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.admin }, ROLE_IDS.superadmin)).toBe(false);
    expect(hasRoleAtLeast(null, ROLE_IDS.admin)).toBe(false);
    expect(hasRoleAtLeast(undefined, ROLE_IDS.admin)).toBe(false);
    expect(hasRoleAtLeast({ roleId: 'role_unknown' }, ROLE_IDS.user)).toBe(false);
  });
});
