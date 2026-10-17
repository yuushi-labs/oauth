import { z } from 'zod';

export const preferencesPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    language: z.string().min(2).max(16).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '更新する項目がありません' });

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;