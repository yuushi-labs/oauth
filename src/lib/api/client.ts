/**
 * 画面からの fetch の一元化（計画 13.1 / D-30-22）。
 * - CSRF トークンをモジュール変数にキャッシュし、mutation には自動付与する
 * - 付与が失敗してもサーバ側（withAuthPipeline）で必ず拒否されるため、ここはUXの問題
 * - 403 CSRF_FAILED は 1 回だけ再取得して再試行する（無限ループは禁止）
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let cachedCsrf: string | null = null;

/** ログイン/ログアウト時はセッション由来のトークンが変わるため破棄する。 */
export function resetCsrfCache(): void {
  cachedCsrf = null;
}

async function fetchCsrfToken(): Promise<string> {
  if (cachedCsrf) return cachedCsrf;
  const response = await fetch('/api/auth/csrf', { cache: 'no-store' });
  const body = (await response.json()) as { success: boolean; data?: { csrfToken?: string } };
  if (!body?.success || !body.data?.csrfToken) throw new ApiClientError('CSRF_FAILED', 'リクエストを検証できませんでした。', 403);
  cachedCsrf = body.data.csrfToken;
  return cachedCsrf;
}

export type ApiRequest = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * 明示的に指定する CSRF トークン。
   *
   * サーバーがレイアウト描画と一緒に発行したトークンをそのまま送りたい場合に使う。
   * クライアントが後から `/api/auth/csrf` を叩いて取得したトークンは、
   * ブラウザが Cookie _accept できていないと Cookie 側と食い違い 403 になる（BUG-15）。
   */
  csrfToken?: string;
};

export async function apiRequest<T>(path: string, init: ApiRequest = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const send = async (): Promise<Response> => {
    if (method !== 'GET' && method !== 'HEAD') {
      headers['X-CSRF-Token'] = init.csrfToken ?? (await fetchCsrfToken());
    }
    return fetch(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  };

  let response = await send();
  if (response.status === 403) {
    // CSRF 失効の可能性がある。1 回だけ取り直して再試行する。
    resetCsrfCache();
    response = await send();
  }

  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || !payload?.success) {
    const error = payload && 'error' in payload ? payload.error : undefined;
    throw new ApiClientError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? '処理に失敗しました。時間をおいて再度お試しください。',
      response.status,
    );
  }
  return payload.data;
}

export const apiClient = {
  get: <T>(path: string, options: { signal?: AbortSignal } = {}) => apiRequest<T>(path, options),
  post: <T>(path: string, body?: unknown, options: { signal?: AbortSignal; csrfToken?: string } = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};