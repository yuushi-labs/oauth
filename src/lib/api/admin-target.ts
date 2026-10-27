import { ApiError } from '@/lib/errors';
import { findAdminTarget } from '@/lib/db/queries/admin';
import { targetIdParamSchema } from '@/lib/validate/admin';
import type { User } from '@/lib/db/schema';

/**
 * 管理操作の対象ユーザーを解決する（§49 / D-35-10 / D-35-11）。
 *
 * - ID 形式が不正・存在しない・論理削除済み → 404 `ADMIN_NOT_FOUND`（他人の存在を教えない）
 * - 自分自身が対象 → 409 `CANNOT_TARGET_SELF`（自己ロックアウト防止）
 */
export async function resolveAdminTarget(rawId: string, actor: User): Promise<User> {
  const id = targetIdParamSchema.safeParse(rawId);
  if (!id.success) throw new ApiError('ADMIN_NOT_FOUND', '対象のユーザーが見つかりません');

  const target = await findAdminTarget(id.data);
  if (!target) throw new ApiError('ADMIN_NOT_FOUND', '対象のユーザーが見つかりません');
  if (target.id === actor.id) throw new ApiError('CANNOT_TARGET_SELF', '自分自身に対してこの操作はできません');

  return target;
}
