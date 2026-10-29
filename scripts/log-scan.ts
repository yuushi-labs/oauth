import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { scanForSecrets } from '@/lib/ops/log-scan';

/**
 * ログの secret 検知 CLI（Phase 9 / P9-A-06・D-39-06）。
 *
 * `pnpm logs:scan <file>` または `pnpm logs:scan -`（標準入力）。
 * 検出結果は**行番号と種別のみ**を出し、値は出力しない（検知器を漏洩源にしない・§45）。
 *
 * 既定では URL に載る認証トークン（`token` / `code` / `state` / `nonce` / `code_verifier`）だけを
 * 検出する。`--credentials` を付けると `password` / `secret` 等も対象になる（誤検知が増える）。
 */

async function readInput(target: string): Promise<string> {
  if (target === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(target, 'utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeCredentialKeys = args.includes('--credentials');
  const target = args.find((arg) => !arg.startsWith('--'));
  if (!target) {
    process.stderr.write('usage: pnpm logs:scan <file>|- [--credentials]\n');
    process.exitCode = 1;
    return;
  }
  const findings = scanForSecrets(await readInput(target), { includeCredentialKeys });
  if (findings.length === 0) {
    process.stdout.write('no secrets detected\n');
    return;
  }
  for (const finding of findings) {
    process.stdout.write(`line ${finding.line}: ${finding.key}\n`);
  }
  process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void import('dotenv/config').then(main).catch((error: unknown) => {
    process.stderr.write(`log scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
