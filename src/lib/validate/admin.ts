import { z } from 'zod';
import { parseId } from '@/lib/util/id';

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
