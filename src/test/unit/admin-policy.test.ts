import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '@/lib/errors';
import { ROLE_IDS } from '@/lib/db/schema';

const totpState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/db/queries/totp', () => ({
  findTotpByUserId: async () => (totpState.enabled ? { enabled: true } : null),
}));

import {
  hasRoleAtLeast,
  isAdminRole,
  requireAdminAccess,
  requireRole,
  roleRank,
} from '@/lib/auth/admin-policy';

function userWithRole(roleId: string) {
  return {
    id: 'usr_test',
    username: 'u',
    email: 'u@example.com',
    emailVerified: true,
    passwordHash: 'hash',
    passwordChangedAt: null,
    displayName: null,
    avatarUrl: null,
    status: 'active',
    roleId,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

describe('roleRank / isAdminRole', () => {
  it('rank は user=0 / moderator=1 / admin=2 / superadmin=3、未知は -1', () => {
    expect(roleRank(ROLE_IDS.user)).toBe(0);
    expect(roleRank(ROLE_IDS.moderator)).toBe(1);
    expect(roleRank(ROLE_IDS.admin)).toBe(2);
    expect(roleRank(ROLE_IDS.superadmin)).toBe(3);
    expect(roleRank('role_unknown')).toBe(-1);
    expect(roleRank('')).toBe(-1);
  });

  it('isAdminRole は admin 以上のみ true', () => {
    expect(isAdminRole(ROLE_IDS.admin)).toBe(true);
    expect(isAdminRole(ROLE_IDS.superadmin)).toBe(true);
    expect(isAdminRole(ROLE_IDS.moderator)).toBe(false);
    expect(isAdminRole(ROLE_IDS.user)).toBe(false);
    expect(isAdminRole('')).toBe(false);
  });
});

describe('hasRoleAtLeast', () => {
  it('rank の下限で判定する', () => {
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.admin }, ROLE_IDS.admin)).toBe(true);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.superadmin }, ROLE_IDS.admin)).toBe(true);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.moderator }, ROLE_IDS.admin)).toBe(false);
    expect(hasRoleAtLeast({ roleId: ROLE_IDS.user }, ROLE_IDS.moderator)).toBe(false);
    expect(hasRoleAtLeast(null, ROLE_IDS.user)).toBe(false);
    expect(hasRoleAtLeast(undefined, ROLE_IDS.user)).toBe(false);
  });
});

describe('requireRole', () => {
  it('権限が足りなければ FORBIDDEN を投げる', () => {
    try {
      requireRole({ roleId: ROLE_IDS.user }, ROLE_IDS.admin);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('FORBIDDEN');
      expect((error as ApiError).status).toBe(403);
    }
  });

  it('null でも FORBIDDEN', () => {
    expect(() => requireRole(null, ROLE_IDS.admin)).toThrow(ApiError);
  });

  it('権限があれば何も投げない', () => {
    expect(() => requireRole({ roleId: ROLE_IDS.admin }, ROLE_IDS.admin)).not.toThrow();
  });
});

describe('requireAdminAccess', () => {
  it('一般ユーザーは FORBIDDEN', async () => {
    totpState.enabled = true;
    await expect(requireAdminAccess(userWithRole(ROLE_IDS.user))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('管理者でも 2FA 無効なら ADMIN_2FA_REQUIRED', async () => {
    totpState.enabled = false;
    await expect(requireAdminAccess(userWithRole(ROLE_IDS.admin))).rejects.toMatchObject({
      code: 'ADMIN_2FA_REQUIRED',
      status: 403,
    });
  });

  it('管理者かつ 2FA 有効なら通る', async () => {
    totpState.enabled = true;
    await expect(requireAdminAccess(userWithRole(ROLE_IDS.admin))).resolves.toBeUndefined();
  });
});

describe('admin-policy の静的検査', () => {
  it('request / headers を受け取らない（§49）', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/auth/admin-policy.ts'), 'utf8');
    expect(source).not.toMatch(/\bheaders\b/);
    expect(source).not.toMatch(/\brequest\b/);
    expect(source).not.toMatch(/NextRequest/);
  });
});
