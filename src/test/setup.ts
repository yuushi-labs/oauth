import { randomBytes } from 'node:crypto';
import { generateTotpEncryptionKey } from '@/lib/util/crypto';

const TEST_ENV = {
  DATABASE_URL: 'postgresql://app:dev_password@localhost:5432/app',
  SESSION_PEPPER: 's'.repeat(43),
  TOKEN_PEPPER: 't'.repeat(43),
  IP_HASH_PEPPER: 'i'.repeat(43),
  CSRF_SECRET: 'c'.repeat(43),
  TOTP_ENCRYPTION_KEY: generateTotpEncryptionKey(),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  HIBP_TIMEOUT_MS: '1000',
  BREACH_CHECK_FAIL_OPEN: 'true',
  OIDC_ADAPTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  // e2e（oauth-flow / social-confirm-flow）は provider の authorize URL まで
  // 実 Route Handler を通す。`isConfigured` は未設定 provider を無効化する（D-30-21）ため、
  // テスト用のダミー資格情報を注入して provider を有効化する。
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-client-secret',
  DISCORD_CLIENT_ID: 'test-discord-client-id',
  DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}