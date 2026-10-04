import { z } from 'zod';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 大文字小文字の一意性は DB の partial unique index が担保する（D-04）。 */
export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, `ユーザー名は ${USERNAME_MIN_LENGTH} 文字以上で入力してください`)
  .max(USERNAME_MAX_LENGTH, `ユーザー名は ${USERNAME_MAX_LENGTH} 文字以下で入力してください`)
  .regex(USERNAME_PATTERN, 'ユーザー名は英数字・ハイフン・アンダースコアのみ使用できます');

export type UsernameInput = z.input<typeof usernameSchema>;
export type Username = z.output<typeof usernameSchema>;