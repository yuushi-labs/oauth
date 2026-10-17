import { OIDC_CLIENT_TYPES, OIDC_SCOPES, type OidcClientType, type OidcScope } from '@/lib/db/schema';

export { OIDC_SCOPES, OIDC_CLIENT_TYPES };
export type { OidcScope, OidcClientType };

export function isOidcScope(value: string): value is OidcScope {
  return (OIDC_SCOPES as readonly string[]).includes(value);
}

export function isOidcClientType(value: string | undefined): value is 'public' | 'confidential' {
  return value === 'public' || value === 'confidential';
}

export function parseOidcScopes(value: string | undefined): OidcScope[] {
  return [...new Set((value ?? '').split(/[\s,]+/u).filter(isOidcScope))];
}

export function hasDisallowedScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => !isOidcScope(scope));
}

export function isScopeSubset(requested: readonly string[], allowed: readonly string[]): boolean {
  return requested.every((scope) => allowed.includes(scope));
}