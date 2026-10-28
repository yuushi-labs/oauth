import { ApiError } from '@/lib/errors';
import { ROLE_IDS } from '@/lib/db/schema';
import { roleRank } from '@/lib/auth/admin-policy';
import { countOtherUsableAdmins, setUserRole } from '@/lib/db/queries/admin';
import { recordAdminAudit } from '@/lib/auth/audit';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import type { User } from '@/lib/db/schema';

/**
 * role 付与（Phase 7.5）。
 *
 * 付与可能な role は `maxRank` で制限する。API は `admin`（=2）を渡して
 * `superadmin` への昇格を塞ぎ（D-36-01）、CLI は `superadmin`（=3）を渡して
 * 全 role を扱える（D-36-06）。
 */
const ASSIGNABLE_ROLE_IDS = Object.values(ROLE_IDS) as readonly string[];
export type AssignableRoleId = (typeof ROLE_IDS)[keyof typeof ROLE_IDS];

export function isAssignableRole(roleId: string, maxRank: number): boolean {
  return ASSIGNABLE_ROLE_IDS.includes(roleId) && roleRank(roleId) <= maxRank;
}

export type ChangeRoleResult = { previousRoleId: string; roleId: string; changed: boolean };

/**
 * 対象ユーザーの role を変更する。
 *
 * - `maxRank` を超える role への変更は 400（`role_superadmin` を API から弾く・D-36-01）
 * - 有効な管理者が対象だけなら降格させない → 409 `LAST_ADMIN`（D-36-03）
 *
 * セッションは失効させない。認可は全リクエストで `findUserById` を引き直すため、
 * 変更は次のリクエストから即時反映される（D-36-04）。
 */
export async function changeUserRole(input: {
  target: User;
  roleId: string;
  maxRank: number;
}): Promise<ChangeRoleResult> {
  const { target, roleId, maxRank } = input;

  if (!isAssignableRole(roleId, maxRank)) {
    throw new ApiError('VALIDATION_ERROR', '指定された権限は付与できません。');
  }

  const previousRoleId = target.roleId;
  if (previousRoleId === roleId) {
    return { previousRoleId, roleId, changed: false };
  }

  const demotingAdmin =
    roleRank(previousRoleId) >= roleRank(ROLE_IDS.admin) && roleRank(roleId) < roleRank(ROLE_IDS.admin);
  if (demotingAdmin && (await countOtherUsableAdmins(target.id)) === 0) {
    throw new ApiError('LAST_ADMIN');
  }

  await setUserRole(target.id, roleId);
  return { previousRoleId, roleId, changed: true };
}

/**
 * role 変更を適用し、監査ログとセキュリティイベントを残す（API / CLI 共通）。
 *
 * `actorUserId` が無い場合（CLI の bootstrap）は、記録すべき操作主体が存在しないため
 * 監査ログには記録せず、`security_events` にのみ記録する（D-36-05）。
 */
export async function applyRoleChange(input: {
  target: User;
  roleId: string;
  maxRank: number;
  actorUserId: string | null;
  actorUsername?: string | null;
  ip: string;
  userAgent: string;
}): Promise<ChangeRoleResult> {
  const result = await changeUserRole(input);
  if (!result.changed) return result;

  await recordSecurityEvent('role_changed', input.target.id, input.ip, input.userAgent, {
    role: result.roleId,
    previous_role: result.previousRoleId,
    by: input.actorUserId ?? 'cli',
  });
  if (input.actorUserId) {
    await recordAdminAudit({
      action: 'admin_role_changed',
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      targetUserId: input.target.id,
      targetUsername: input.target.username,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { role: result.roleId, previous_role: result.previousRoleId },
    });
  }
  return result;
}
