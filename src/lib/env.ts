import { z } from 'zod';

const MIN_PEPPER_LENGTH = 32;
const TOTP_KEY_BYTES = 32;

const isBase64OfLength = (value: string, bytes: number): boolean => {
  try {
    return Buffer.from(value, 'base64').length === bytes;
  } catch {
    return false;
  }
};

const requiredEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL が未設定です'),
  SESSION_PEPPER: z
    .string()
    .min(MIN_PEPPER_LENGTH, `SESSION_PEPPER は ${MIN_PEPPER_LENGTH} 文字以上必要です`),
  TOKEN_PEPPER: z
    .string()
    .min(MIN_PEPPER_LENGTH, `TOKEN_PEPPER は ${MIN_PEPPER_LENGTH} 文字以上必要です`),
  IP_HASH_PEPPER: z
    .string()
    .min(MIN_PEPPER_LENGTH, `IP_HASH_PEPPER は ${MIN_PEPPER_LENGTH} 文字以上必要です`),
  CSRF_SECRET: z
    .string()
    .min(MIN_PEPPER_LENGTH, `CSRF_SECRET は ${MIN_PEPPER_LENGTH} 文字以上必要です`),
  TOTP_ENCRYPTION_KEY: z
    .string()
    .refine((value) => isBase64OfLength(value, TOTP_KEY_BYTES), {
      message: `TOTP_ENCRYPTION_KEY は Base64 エンコードされた ${TOTP_KEY_BYTES} バイトである必要があります`,
    }),
  NEXT_PUBLIC_APP_URL: z.string().url('NEXT_PUBLIC_APP_URL が不正な URL です'),
  REDIS_URL: z.string().url('REDIS_URL が不正な URL です').optional(),
  HIBP_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  BREACH_CHECK_FAIL_OPEN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof requiredEnvSchema>;

const LAZY_ENV_PURPOSE = {
  RESEND_API_KEY: 'メール送信（Phase 1-B）',
  EMAIL_FROM: 'メール送信（Phase 1-B）',
  GOOGLE_CLIENT_ID: 'Google OAuth（Phase 4-A）',
  GOOGLE_CLIENT_SECRET: 'Google OAuth（Phase 4-A）',
  GITHUB_CLIENT_ID: 'GitHub OAuth（Phase 4-A）',
  GITHUB_CLIENT_SECRET: 'GitHub OAuth（Phase 4-A）',
  DISCORD_CLIENT_ID: 'Discord OAuth（Phase 4-A）',
  DISCORD_CLIENT_SECRET: 'Discord OAuth（Phase 4-A）',
  TURNSTILE_SECRET_KEY: 'CAPTCHA（Phase 9）',
} as const;

export type LazyEnvKey = keyof typeof LAZY_ENV_PURPOSE;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`環境変数の検証に失敗しました:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export type EnvSource = Record<string, string | undefined>;

export function parseEnv(source: EnvSource): Env {
  const result = requiredEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

let cached: Env | null = null;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

/** 遅延評価が必要な変数。参照した時点で未設定なら throw する（起動は止めない）。 */
export function requireLazyEnv<K extends LazyEnvKey>(key: K): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} が未設定です（${LAZY_ENV_PURPOSE[key]}で必要です）`);
  }
  return value;
}

export function hasLazyEnv(key: LazyEnvKey): boolean {
  return Boolean(process.env[key]);
}

export const APP_URL_DEFAULT = 'http://localhost:3000';
export const PASSWORD_HASH_PEPPER_MIN_LENGTH = MIN_PEPPER_LENGTH;