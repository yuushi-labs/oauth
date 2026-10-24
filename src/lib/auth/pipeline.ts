import { createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { timingSafeEqualStr } from '@/lib/util/crypto';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';
import { isTrustedOrigin } from '@/lib/auth/origin';
import { getAnonCsrfSecret } from '@/lib/auth/cookie';

export function isAllowedOrigin(origin: string | null, referer?: string | null): boolean {
  return isTrustedOrigin(origin, referer);
}

export function deriveCsrfToken(session: SessionData): string {
  const env = getEnv();
  return createHmac('sha256', env.CSRF_SECRET)
    .update(`${session.id}:${session.csrfSecret}`)
    .digest('hex');
}

export function validateOriginHeader(origin: string | null, referer?: string | null): void {
  if (!isAllowedOrigin(origin, referer)) {
    throw new ApiError('CSRF_FAILED', '不正なリクエスト元です');
  }
}

export function validateCsrfToken(
  csrfToken: string | null,
  session: SessionData | null,
  anonCookieValue: string | null = null,
): void {
  if (!csrfToken) {
    throw new ApiError('CSRF_FAILED', 'CSRF トークンが不足しています');
  }
  if (session) {
    const expected = deriveCsrfToken(session);
    if (!timingSafeEqualStr(csrfToken, expected)) {
      throw new ApiError('CSRF_FAILED', 'CSRF トークンが不一致です');
    }
    return;
  }

  const expected = getAnonCsrfSecret(anonCookieValue);
  if (!expected || !timingSafeEqualStr(csrfToken, expected)) {
    throw new ApiError('CSRF_FAILED', 'CSRF トークンが不一致です');
  }
}

export async function checkReauthRequired(session: SessionData | null): Promise<void> {
  if (session) {
    const { checkReauth } = await import('@/lib/auth/reauth');
    checkReauth(session);
  }
}

export type PipelineOptions = {
  requireAuth?: boolean;
  requireReauth?: boolean;
  /**
   * 2FA 保留セッション（`totpPending`）を拒否するか。既定は `true`（fail closed・D-33-08）。
   * `false` を渡してよいのはホワイトリストの 5 経路のみ（§9.4）。
   */
  denyTotpPending?: boolean;
};

export type PipelineContext = {
  user: User | null;
  session: SessionData | null;
  body: unknown;
};

export type CorePipelineDeps = {
  getOrigin: () => string | null;
  getReferer?: () => string | null;
  getMethod: () => string;
  getCsrfToken: () => string | null;
  getCookieToken: () => string | null;
  getAnonCookieToken: () => string | null;
  getContentType: () => string | null;
  parseJsonBody: () => Promise<unknown>;
  getSession: (token: string) => Promise<SessionData | null>;
  findUserById: (id: string) => Promise<User | null>;
};

export async function runCorePipeline(
  deps: CorePipelineDeps,
  options: PipelineOptions,
  handler: (ctx: PipelineContext) => Promise<Response>,
): Promise<Response> {
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(deps.getMethod().toUpperCase());

  const origin = deps.getOrigin();
  if (isMutation) {
    validateOriginHeader(origin, deps.getReferer?.() ?? null);
  }

  const cookieToken = deps.getCookieToken();
  let session: SessionData | null = null;
  let user: User | null = null;
  if (cookieToken) {
    session = await deps.getSession(cookieToken);
    if (session) {
      user = await deps.findUserById(session.userId);
    }
  }

  if (isMutation) {
    const csrfToken = deps.getCsrfToken();
    validateCsrfToken(csrfToken, session, deps.getAnonCookieToken());
  }

  if (options.requireAuth && !session) {
    throw new ApiError('SESSION_EXPIRED', 'セッションの有効期限が切れました');
  }

  // 2FA 保留セッションの封じ込め（D-33-08）。既定で拒否し、ホワイトリストの経路だけが false を渡す。
  if (session && session.totpPending && options.denyTotpPending !== false) {
    throw new ApiError('TOTP_REQUIRED', '2 段階認証を完了してください');
  }

  let body: unknown = undefined;
  if (isMutation && deps.getContentType()?.includes('application/json')) {
    try {
      body = await deps.parseJsonBody();
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'リクエスト本文の解析に失敗しました');
    }
  }

  if (options.requireReauth && session) {
    await checkReauthRequired(session);
  }

  return handler({ user, session, body });
}
