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
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}