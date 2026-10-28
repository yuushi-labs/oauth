import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * リクエスト相関 ID（§45・P9-04）。
 *
 * middleware が `x-request-id` を採番し、API パイプラインがハンドラ実行中だけ
 * AsyncLocalStorage に載せる。ログは `logger` が自動で `requestId` を付けるため、
 * 呼び出し側は何も渡さなくてよい。
 */
const storage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run(requestId, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore();
}

/** middleware が付けた ID を検証して使う。外部入力なので形式を限定する（長さ・文字種）。 */
export function normalizeRequestId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : null;
}
