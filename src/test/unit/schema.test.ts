import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DEFAULT_ROLE_ID, ROLE_IDS, ROLE_SEED, USER_STATUSES, roles, users } from '@/lib/db/schema';

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