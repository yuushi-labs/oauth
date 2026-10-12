import { createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { timingSafeEqualStr } from '@/lib/util/crypto';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

const ALLOWED_ORIGINS = [process.env.NEXT_PUBLIC_APP_URL].filter(Boolean) as string[];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

export function deriveCsrfToken(session: SessionData): string {
  const env = getEnv();
  return createHmac('sha256', env.CSRF_SECRET)
    .update(`${session.id}:${session.csrfSecret}`)
    .digest('hex');
}

export function validateOriginHeader(origin: string | null): void {
  if (origin && !isAllowedOrigin(origin)) {
    throw new ApiError('CSRF_FAILED', '不正なリクエスト元です');
  }
}

export function validateCsrfToken(
  csrfToken: string | null,
  session: SessionData | null,
): void {
  if (!csrfToken) {
    throw new ApiError('CSRF_FAILED', 'CSRF トークンが不足しています');
  }
  if (session) {
    const expected = deriveCsrfToken(session);
    if (!timingSafeEqualStr(csrfToken, expected)) {
      throw new ApiError('CSRF_FAILED', 'CSRF トークンが不一致です');
    }
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
};

export type PipelineContext = {
  user: User | null;
  session: SessionData | null;
  body: unknown;
};

export type CorePipelineDeps = {
  getOrigin: () => string | null;
  getCsrfToken: () => string | null;
  getCookieToken: () => string | null;
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
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
    (deps.getContentType() ?? '').toUpperCase() ? 'POST' : 'GET'
  );

  const origin = deps.getOrigin();
  if (isMutation) {
    validateOriginHeader(origin);
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
    validateCsrfToken(csrfToken, session);
  }

  if (options.requireAuth && !session) {
    throw new ApiError('SESSION_EXPIRED', 'セッションの有効期限が切れました');
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