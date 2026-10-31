import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup } from '@/lib/ops/backup';
import { getEnv } from '@/lib/env';
import { describeErrorChain } from '@/lib/util/error-chain';

/**
 * バックアップ CLI（Phase 9 / P9-A-03）。
 *
 * `pnpm backup [--out <dir>] [--keep <days>]`
 * 暗号化鍵（`BACKUP_ENCRYPTION_KEY`）が未設定なら失敗する（平文で書かない・D-39-03）。
 */

const DEFAULT_OUT_DIR = 'backups';

function parseArgs(argv: string[]): { outDir: string; keepDays?: number } {
  let outDir = DEFAULT_OUT_DIR;
  let keepDays: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out' && argv[index + 1]) outDir = argv[index + 1] as string;
    if (argv[index] === '--keep' && argv[index + 1]) keepDays = Number(argv[index + 1]);
  }
  return { outDir, keepDays };
}

async function main(): Promise<void> {
  const env = getEnv();
  const { outDir, keepDays } = parseArgs(process.argv.slice(2));
  if (!env.BACKUP_ENCRYPTION_KEY) {
    process.stderr.write('BACKUP_ENCRYPTION_KEY が未設定です。平文でのバックアップは行いません。\n');
    process.exitCode = 1;
    return;
  }
  const path = await createBackup({
    outDir,
    key: env.BACKUP_ENCRYPTION_KEY,
    databaseUrl: env.DATABASE_URL,
    keepDays,
  });
  process.stdout.write(`backup created: ${path}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void import('dotenv/config').then(main).catch((error: unknown) => {
    process.stderr.write(`backup failed: ${describeErrorChain(error)}\n`);
    process.exitCode = 1;
  });
}
