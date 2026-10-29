import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePepper, generateTotpEncryptionKey } from '../src/lib/util/crypto';

const ENV_PATH = resolve(process.cwd(), '.env');

const SECRET_KEYS = [
  'SESSION_PEPPER',
  'TOKEN_PEPPER',
  'IP_HASH_PEPPER',
  'CSRF_SECRET',
  'TOTP_ENCRYPTION_KEY',
  'BACKUP_ENCRYPTION_KEY',
] as const;

const DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgresql://app:dev_password@localhost:5432/app',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  HIBP_TIMEOUT_MS: '1500',
  BREACH_CHECK_FAIL_OPEN: 'true',
  CAPTCHA_TIMEOUT_MS: '3000',
  POSTGRES_USER: 'app',
  POSTGRES_DB: 'app',
  POSTGRES_PASSWORD: 'dev_password',
};

function generateValue(key: (typeof SECRET_KEYS)[number]): string {
  return key === 'TOTP_ENCRYPTION_KEY' || key === 'BACKUP_ENCRYPTION_KEY'
    ? generateTotpEncryptionKey()
    : generatePepper();
}

function main(): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const presentKeys = new Set(
    existing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.slice(0, line.indexOf('=')))
      .filter((key) => key.length > 0),
  );

  const additions: string[] = [];

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!presentKeys.has(key)) {
      additions.push(`${key}=${value}`);
    }
  }

  const generated: string[] = [];
  for (const key of SECRET_KEYS) {
    if (!presentKeys.has(key)) {
      additions.push(`${key}=${generateValue(key)}`);
      generated.push(key);
    }
  }

  if (additions.length === 0) {
    console.log('.env は既にすべての項目が揃っています（未生成: 0）');
    return;
  }

  const header = '# ローカル開発用の環境変数。commit しないこと（仕様52章）\n';
  const body = `${header}${existing.trimEnd()}${existing.length > 0 ? '\n\n' : ''}${additions.join('\n')}\n`;

  writeFileSync(ENV_PATH, body, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);

  console.log(`.env を作成/更新しました（権限 600）`);
  console.log(`生成したシークレット: ${generated.length > 0 ? generated.join(', ') : 'なし'}`);
  console.log('※ 値は出力していません。必要なら .env を直接確認してください。');
}

main();