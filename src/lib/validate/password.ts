import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Phase 0 は形式の検証のみ（長さ・空白のみ拒否）。
 * NGワード判定・既知の漏洩パスワード判定・Argon2id は Phase 1-A で追加する。
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `パスワードは ${PASSWORD_MIN_LENGTH} 文字以上で入力してください`)
  .max(PASSWORD_MAX_LENGTH, `パスワードは ${PASSWORD_MAX_LENGTH} 文字以下で入力してください`)
  .refine((value) => value.trim().length > 0, 'パスワードを空白のみにはできません');

export type Password = z.infer<typeof passwordSchema>;