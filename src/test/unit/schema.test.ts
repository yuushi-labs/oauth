import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DEFAULT_ROLE_ID, ROLE_IDS, ROLE_SEED, USER_STATUSES, roles, users, rolePermissions, adminAuditLogs, ADMIN_AUDIT_ACTIONS } from '@/lib/db/schema';

describe('roles', () => {
  it('id が主キー、name が unique になる', () => {
    const config = getTableConfig(roles);
    expect(config.name).toBe('roles');
    expect(config.columns.find((column) => column.name === 'id')?.primary).toBe(true);
    expect(config.columns.find((column) => column.name === 'name')?.isUnique).toBe(true);
  });
});

describe('users', () => {
  const config = getTableConfig(users);

  it('テーブル名と必須カラムが仕様22章に対応している', () => {
    const names = config.columns.map((column) => column.name);
    expect(config.name).toBe('users');
    for (const column of [
      'id',
      'username',
      'email',
      'email_verified',
      'password_hash',
      'display_name',
      'avatar_url',
      'status',
      'role_id',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(names).toContain(column);
    }
  });

  it('password_hash と deleted_at は NULL 許可（ソーシャル専用・論理削除）', () => {
    const passwordHash = config.columns.find((column) => column.name === 'password_hash');
    const deletedAt = config.columns.find((column) => column.name === 'deleted_at');
    expect(passwordHash?.notNull).toBe(false);
    expect(deletedAt?.notNull).toBe(false);
  });

  it('username / email に通常の UNIQUE 制約を付けていない（D-04）', () => {
    for (const name of ['username', 'email']) {
      const column = config.columns.find((c) => c.name === name);
      expect(column?.isUnique).toBeFalsy();
    }
    expect(config.uniqueConstraints).toHaveLength(0);
  });

  it('partial unique index を 2本定義している', () => {
    const uniqueIndexes = config.indexes.filter((index) => index.config.unique);
    expect(uniqueIndexes.map((index) => index.config.name)).toEqual([
      'users_username_lower_uniq',
      'users_email_lower_uniq',
    ]);
    for (const index of uniqueIndexes) {
      expect(index.config.where).toBeDefined();
    }
  });

  it('status と email_verified の CHECK を定義している', () => {
    expect(config.checks.map((check) => check.name)).toEqual([
      'users_status_chk',
      'users_status_email_verified_chk',
    ]);
  });

  it('role_id は roles への外部キー', () => {
    expect(config.foreignKeys).toHaveLength(1);
  });
});

describe('定数', () => {
  it('status は仕様23章の4値のみ', () => {
    expect(USER_STATUSES).toEqual(['pending_email', 'active', 'suspended', 'deleted']);
  });

  it('既定 role は user', () => {
    expect(DEFAULT_ROLE_ID).toBe(ROLE_IDS.user);
    expect(DEFAULT_ROLE_ID).toBe('role_user');
  });

  it('seed は user / admin を含む4役割を定義する（将来拡張分も定義のみ）', () => {
    expect(ROLE_SEED.map((role) => role.name)).toEqual(['user', 'moderator', 'admin', 'superadmin']);
  });
});

describe('role_permissions (§50・将来拡張用)', () => {
  const config = getTableConfig(rolePermissions);

  it('(role_id, permission) を主キーにする', () => {
    expect(config.name).toBe('role_permissions');
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]!.columns.map((c) => c.name).sort()).toEqual(['permission', 'role_id']);
  });

  it('role_id は roles への外部キー（cascade）', () => {
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]!.onDelete).toBe('cascade');
  });
});

describe('admin_audit_logs (§61)', () => {
  const config = getTableConfig(adminAuditLogs);

  it('監査に必要な列を持つ', () => {
    expect(config.name).toBe('admin_audit_logs');
    const names = config.columns.map((column) => column.name);
    for (const column of [
      'id',
      'actor_user_id',
      'action',
      'target_user_id',
      'target_session_id',
      'ip',
      'ip_masked',
      'user_agent',
      'metadata',
      'created_at',
    ]) {
      expect(names).toContain(column);
    }
  });

  it('actor_user_id は NOT NULL、target_user_id は NULL 許可（D-35-08）', () => {
    const actor = config.columns.find((c) => c.name === 'actor_user_id');
    const target = config.columns.find((c) => c.name === 'target_user_id');
    expect(actor?.notNull).toBe(true);
    expect(target?.notNull).toBe(false);
  });

  it('created_at / actor_user_id / target_user_id に index がある', () => {
    const indexNames = config.indexes.map((index) => index.config.name).sort();
    expect(indexNames).toEqual([
      'admin_audit_logs_actor_user_id_idx',
      'admin_audit_logs_created_at_idx',
      'admin_audit_logs_target_user_id_idx',
    ]);
  });

  it('ADMIN_AUDIT_ACTIONS は 6 アクション（§11.6 + Phase 7.5）', () => {
    expect(ADMIN_AUDIT_ACTIONS).toEqual([
      'admin_user_viewed',
      'admin_user_suspended',
      'admin_user_unsuspended',
      'admin_session_revoked',
      'admin_account_deleted',
      'admin_role_changed',
    ]);
  });
});