import { describe, expect, it } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { OIDC_CLIENT_TYPES, OIDC_SCOPES, oauthClients } from '@/lib/db/schema';
import { hasDisallowedScope, isOidcClientType, isOidcScope, isScopeSubset, parseOidcScopes } from '@/lib/oidc/scopes';

describe('OIDC scope allowlist', () => {
  it('初期値は openid / profile / email のみ', () => {
    expect([...OIDC_SCOPES]).toEqual(['openid', 'profile', 'email']);
    expect(isOidcScope('openid')).toBe(true);
    expect(isOidcScope('offline_access')).toBe(false);
    expect(isOidcScope('admin')).toBe(false);
  });

  it('parseOidcScopes は許可外 scope を落として型安全に返す', () => {
    expect(parseOidcScopes('openid, profile')).toEqual(['openid', 'profile']);
    expect(parseOidcScopes('openid,openid')).toEqual(['openid']);
    expect(parseOidcScopes('openid admin')).toEqual(['openid']);
    expect(parseOidcScopes(undefined)).toEqual([]);
  });

  it('hasDisallowedScope は許可外 scope の混入を検出する', () => {
    expect(hasDisallowedScope(['openid', 'email'])).toBe(false);
    expect(hasDisallowedScope(['openid', 'offline_access'])).toBe(true);
    expect(hasDisallowedScope(['openid', ''])).toBe(true);
  });

  it('isScopeSubset は要求 scope が許可 scope に含まれるかのみ真', () => {
    expect(isScopeSubset(['openid', 'email'], ['openid', 'profile', 'email'])).toBe(true);
    expect(isScopeSubset(['openid', 'profile'], ['openid'])).toBe(false);
    expect(isScopeSubset([], ['openid'])).toBe(true);
  });

  it('isOidcClientType は public / confidential のみ受理する', () => {
    expect(isOidcClientType('public')).toBe(true);
    expect(isOidcClientType('confidential')).toBe(true);
    expect(isOidcClientType('admin')).toBe(false);
    expect(isOidcClientType(undefined)).toBe(false);
  });
});

describe('oauth_clients constraints', () => {
  const config = getTableConfig(oauthClients);

  it('client type / scope allowlist の CHECK が単一ソースから生成されている', () => {
    const dialect = new PgDialect();
    const render = (name: string): string => {
      const check = config.checks.find((candidate) => candidate.name === name);
      if (!check) throw new Error(`missing check ${name}`);
      return dialect.sqlToQuery(check.value).sql;
    };

    const typeCheck = render('oauth_clients_type_chk');
    const scopeCheck = render('oauth_clients_scope_allowlist_chk');
    for (const type of OIDC_CLIENT_TYPES) expect(typeCheck).toContain(`'${type}'::text`);
    for (const scope of OIDC_SCOPES) expect(scopeCheck).toContain(`'${scope}'::text`);
    expect(scopeCheck).not.toContain('offline_access');
  });

  it('DDL にバインド用プレースホルダを漏らさない（migration 生成不能を検出）', () => {
    const dialect = new PgDialect();
    for (const check of config.checks) {
      const query = dialect.sqlToQuery(check.value);
      expect(query.params, `${check.name} must be inlinable`).toHaveLength(0);
    }
  });

  it('operator 列が NOT NULL で定義されている（D-02 運営者開示）', () => {
    const operator = config.columns.find((column) => column.name === 'operator');
    expect(operator?.notNull).toBe(true);
  });
});