import { z } from 'zod';

/**
 * Passkey（WebAuthn）の入力スキーマ（計画 §7.3.6）。
 *
 * **暗号学的検証はスキーマで行わない**。zod は**形**（必須キー・型）だけを検査し、
 * 署名・challenge・origin / rpID の検証は `@simplewebauthn/server` に委ねる（D-34-03）。
 */

/** 登録応答（`@simplewebauthn/browser` の `startRegistration` の戻りをそのまま受ける）。 */
export const registrationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional(),
    }),
    type: z.literal('public-key'),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  })
  .strict();

/** 認証応答（`startAuthentication` の戻り）。 */
export const authenticationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().optional(),
    }),
    type: z.literal('public-key'),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  })
  .strict();

const challengeIdSchema = z.string().regex(/^wch_[0-9A-HJKMNP-TV-Z]{26}$/, 'challenge_id が不正です');

export const registerOptionsSchema = z
  .object({
    device_name: z.string().max(120).optional(),
  })
  .strict()
  .optional();

export const registerVerifySchema = z
  .object({
    response: registrationResponseSchema,
    challenge_id: challengeIdSchema,
    device_name: z.string().max(120).optional(),
  })
  .strict();

export const loginOptionsSchema = z
  .object({})
  .strict()
  .optional();

export const loginVerifySchema = z
  .object({
    response: authenticationResponseSchema,
    challenge_id: challengeIdSchema,
  })
  .strict();

/** 削除の body。パスワード＋コード、または Passkey assertion のどちらかで強い再認証を行う。 */
export const passkeyDeleteSchema = z
  .object({
    code: z.string().min(6).max(64).optional(),
    passkey: authenticationResponseSchema.optional(),
    challenge_id: challengeIdSchema.optional(),
  })
  .strict();

export type RegistrationResponseInput = z.infer<typeof registrationResponseSchema>;
export type AuthenticationResponseInput = z.infer<typeof authenticationResponseSchema>;
