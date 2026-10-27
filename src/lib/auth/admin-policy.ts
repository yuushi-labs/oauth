import { ApiError } from '@/lib/errors';
import { ROLE_IDS } from '@/lib/db/schema';
import { findTotpByUserId } from '@/lib/db/queries/totp';
import type { User } from '@/lib/db/schema';

export type RoleRef = { roleId: string };

/**
 * role の序列（D-35-01）。`moderator` / `superadmin` は定義のみだが、rank 比較に含めることで
 * 将来の権限付与・判定をこの 1 か所の変更で済ませられる（§50）。
 */
const ROLE_RANK: Readonly<Record<string, number>> = {
  [ROLE_IDS.user]: 0,
  [ROLE_IDS.moderator]: 1,
  [ROLE_IDS.admin]: 2,
  [ROLE_IDS.superadmin]: 3,
};

/** 未知の role は最下位（-1）として扱う（fail closed）。 */
export function roleRank(roleId: string): number {
  return ROLE_RANK[roleId] ?? -1;
}

export function isAdminRole(roleId: string): boolean {
  return roleRank(roleId) >= ROLE_RANK[ROLE_IDS.admin]!;
}

/** 認可判定はセッション由来の `user` だけで行う（§49）。HTTP の入力は受け取らない。 */
export function hasRoleAtLeast(user: RoleRef | null | undefined, minimum: string): boolean {
  if (!user) return false;
  return roleRank(user.roleId) >= roleRank(minimum);
}

export function requireRole(user: RoleRef | null | undefined, minimum: string): void {
  if (!hasRoleAtLeast(user, minimum)) {
    throw new ApiError('FORBIDDEN', 'この操作を行う権限がありません');
  }
}

/** 管理者セッションの TTL（秒）。§51「セッション短め」・D-35-03。 */
export const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 時間

/**
 * role からセッションの絶対 TTL（秒）を決める。管理者（role ≥ admin）は 8 時間、
 * それ以外は `undefined`（呼び出し側の既定 = 30 日）を返す。
 */
export function sessionMaxAgeSecondsForRole(roleId: string | null | undefined): number | undefined {
  if (roleId && isAdminRole(roleId)) return ADMIN_SESSION_MAX_AGE_SECONDS;
  return undefined;
}

/**
 * 管理 API の共通ガード（§51・D-35-04）。
 * role ≥ admin に加えて **2FA 有効**を必須にする。ログイン自体は止めないので、
 * 2FA 未設定の管理者が恒久ロックアウトされることはない（設定画面から有効化できる）。
 */
export async function requireAdminAccess(user: User): Promise<void> {
  requireRole(user, ROLE_IDS.admin);
  const totp = await findTotpByUserId(user.id);
  if (!totp?.enabled) {
    throw new ApiError('ADMIN_2FA_REQUIRED', '管理者は 2 段階認証の有効化が必要です');
  }
}
