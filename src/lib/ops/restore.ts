import { readFile } from 'node:fs/promises';
import { decryptBackup } from './backup';
import { runCommand, type CommandRunner } from './command';

/**
 * バックアップからの復元（Phase 9 / D-39-02）。
 *
 * 復号したダンプは**一時ファイルに書かず** `pg_restore` の標準入力へ流す（§53）。
 * 復元先は呼び出し側が明示する（本番 DB へ誤って流さないよう、テストは一時 DB を使う）。
 */

export type RestoreOptions = {
  file: string;
  key: string;
  databaseUrl: string;
  run?: CommandRunner;
};

/**
 * 暗号化バックアップを復号し、`databaseUrl` の DB へ復元する。
 * `--clean --if-exists` で既存オブジェクトを置き換える（同一 DB への再復元を許容）。
 */
export async function restoreBackup(options: RestoreOptions): Promise<void> {
  const run = options.run ?? runCommand;
  const dump = decryptBackup(await readFile(options.file), options.key);
  await run('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--dbname',
    options.databaseUrl,
  ], dump);
}
