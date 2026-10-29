import { spawn } from 'node:child_process';

/**
 * 外部コマンド実行の共通ヘルパー（Phase 9 / D-39-02）。
 *
 * `pg_dump` / `pg_restore` は同じ実行パターン（spawn → stdout 収集 → 終了コード判定 →
 * 標準入力へ書き込み）を共有する。実装を 1 か所に集約し、stderr の切り詰めや
 * `child.on('error')` の扱いが 2 実装で乖離しないようにする。
 */

export type CommandRunner = (command: string, args: string[], stdin?: Buffer) => Promise<Buffer>;

const STDERR_LIMIT = 500;

/** 既定の実行器。stdin を渡すと子プロセスの標準入力へ流す。 */
export const runCommand: CommandRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout));
      const message = Buffer.concat(stderr).toString('utf8').slice(0, STDERR_LIMIT);
      reject(new Error(`${command} exited with ${code}: ${message}`));
    });
    child.stdin.end(stdin ?? undefined);
  });
