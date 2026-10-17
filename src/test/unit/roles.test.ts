import { describe, expect, it } from 'vitest';
import { canManageAnyOidcClient, isOidcClientPrivilegedRole } from '@/lib/auth/roles';
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
