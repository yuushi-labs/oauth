import { z } from 'zod';
import { emailSchema } from '@/lib/validate/email';

/** 未認証でも呼べる確認メール再送（D-33-22）。 */
export const resendVerificationSchema = z
  .object({
    email: emailSchema.optional(),
    captchaToken: z.string().optional(),
  })
  .strict();
