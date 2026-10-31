import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreBackup } from '@/lib/ops/restore';
import { getEnv } from '@/lib/env';
import { describeErrorChain } from '@/lib/util/error-chain';

/**
 * 復元 CLI（Phase 9 / P9-A-03）。
 *
 * `pnpm restore --file <path> [--database <url>]`
 * 既定の復元先は `DATABASE_URL`。**本番 DB を指定しない**よう注意（ランブック参照）。
 */

function parseArgs(argv: string[]): { file?: string; databaseUrl?: string } {
  let file: string | undefined;
  let databaseUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file' && argv[index + 1]) file = argv[index + 1] as string;
    if (argv[index] === '--database' && argv[index + 1]) databaseUrl = argv[index + 1] as string;
  }
  return { file, databaseUrl };
}

async function main(): Promise<void> {
  const env = getEnv();
  const { file, databaseUrl } = parseArgs(process.argv.slice(2));
  if (!file) {
    process.stderr.write('--file <path> を指定してください。\n');
    process.exitCode = 1;
    return;
  }
  if (!env.BACKUP_ENCRYPTION_KEY) {
    process.stderr.write('BACKUP_ENCRYPTION_KEY が未設定です。\n');
    process.exitCode = 1;
    return;
  }
  await restoreBackup({ file, key: env.BACKUP_ENCRYPTION_KEY, databaseUrl: databaseUrl ?? env.DATABASE_URL });
  process.stdout.write('restore completed\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void import('dotenv/config').then(main).catch((error: unknown) => {
    process.stderr.write(`restore failed: ${describeErrorChain(error)}\n`);
    process.exitCode = 1;
  });
}
