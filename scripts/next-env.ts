import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Next.js の app-render は読み込み時の `globalThis.AsyncLocalStorage` 有無で実体を確定する。
 * `next` CLI 起動時のみ node-environment が先に読み込まれるため、custom server
 * （`scripts/server.ts`）ではその経路を通らない。先に読み込まないと初回リクエスト時に
 * "Invariant: AsyncLocalStorage accessed in runtime where it is not available" で落ちる。
 *
 * このファイルは `scripts/server.ts` の最初の import である必要がある（import は巻き上がる）。
 */
require('next/dist/server/node-environment');
