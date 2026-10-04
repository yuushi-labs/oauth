import { z } from 'zod';

export const EMAIL_MAX_LENGTH = 254;

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'メールアドレスを入力してください')
  .max(EMAIL_MAX_LENGTH, `メールアドレスは ${EMAIL_MAX_LENGTH} 文字以下で入力してください`)
  .email('メールアドレスの形式が正しくありません')
  .transform((value) => value.toLowerCase());

export type EmailInput = z.input<typeof emailSchema>;
export type Email = z.output<typeof emailSchema>;