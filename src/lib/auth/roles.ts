import { ROLE_IDS } from '@/lib/db/schema';

const OIDC_CLIENT_ADMIN_ROLES: ReadonlySet<string> = new Set([ROLE_IDS.admin, ROLE_IDS.superadmin]);

export type RoleRef = { roleId: string };

/** Administrators may manage every client; regular users only their own. */
export function canManageAnyOidcClient(user: RoleRef | null | undefined): boolean {
  return Boolean(user && OIDC_CLIENT_ADMIN_ROLES.has(user.roleId));
}

export function isOidcClientPrivilegedRole(roleId: string): boolean {
  return OIDC_CLIENT_ADMIN_ROLES.has(roleId);
}
