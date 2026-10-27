import { z } from 'zod';
import { parseId } from '@/lib/util/id';
import { ROLE_IDS } from '@/lib/db/schema';

/** 管理 API の一覧クエリ（§11.6）。 */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** パスパラメータの user ID（`usr_` + ULID）。不正形式は 400 にする。 */
export const targetIdParamSchema = z
  .string()
  .refine((value) => {
    try {
      parseId(value, 'usr');
      return true;
    } catch {
      return false;
    }
  }, '対象ユーザー ID の形式が正しくありません');

/**
 * role 変更の body（Phase 7.5）。付与可能な role は `admin-role.ts` の
 * `isAssignableRole`（rank ≤ admin）で判定する。ここでは形式のみ検証する。
 */
const ROLE_IDS_VALUES = Object.values(ROLE_IDS) as [string, ...string[]];

export const roleChangeSchema = z.object({
  role_id: z.enum(ROLE_IDS_VALUES),
});
