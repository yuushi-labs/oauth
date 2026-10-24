import { z } from 'zod';

export const totpCodeSchema = z.string().regex(/^\d{6}$/, '6 桁の数字を入力してください');

/** 正規化前のリカバリーコードを受ける（大文字小文字・ハイフンは後段で吸収する）。 */
export const recoveryCodeSchema = z.string().min(10).max(64);

/**
 * `code` を 1 フィールドにする理由: UI は入力欄 1 つで、利用者は「リカバリーコードを使う」導線で
 * 同じ欄を使う。サーバは「6 桁の数字なら TOTP、それ以外ならリカバリーコード」と自動判別する。
 */
export const totpDisableSchema = z
  .object({
    code: z.string().min(6).max(64),
  })
  .strict();

export const totpVerifySchema = z
  .object({
    code: z.string().min(6).max(64),
  })
  .strict();

export const totpChallengeSchema = z
  .object({
    code: z.string().min(6).max(64),
  })
  .strict();
