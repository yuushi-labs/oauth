import { NextRequest, NextResponse } from 'next/server';
import { normalizeError, ok, type ApiErrorBody } from '@/lib/errors';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import { runCorePipeline } from '@/lib/auth/pipeline';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';
import { getAnonCookieName, getSessionCookieName } from '@/lib/auth/cookie';

export function handleApiError(error: unknown): NextResponse<ApiErrorBody> {
  const { status, body } = normalizeError(error);
  return NextResponse.json(body, { status });
}

export function handleSuccess<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(ok(data), { status });
}

export async function parseJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export function getCookieToken(request: NextRequest): string | null {
  return request.cookies.get(getSessionCookieName())?.value ?? null;
}

export function failResponse(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export function rateLimitResponse(resetAt: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { success: false, error: { code: 'RATE_LIMITED', message: 'リクエストが多すぎます' } },
    { status: 429, headers: { 'Retry-After': retryAfter.toString(), 'Cache-Control': 'no-store' } },
  );
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

export async function withAuthPipeline(
  request: NextRequest,
  options: PipelineOptions,
  handler: (ctx: PipelineContext) => Promise<Response>,
): Promise<Response> {
  const deps = {
    getOrigin: () => request.headers.get('origin'),
    getReferer: () => request.headers.get('referer'),
    getMethod: () => request.method,
    getCsrfToken: () => request.headers.get('x-csrf-token'),
    getCookieToken: () => getCookieToken(request),
    getAnonCookieToken: () => request.cookies.get(getAnonCookieName())?.value ?? null,
    getContentType: () => request.headers.get('content-type'),
    parseJsonBody: () => request.json(),
    getSession,
    findUserById,
  };

  try {
    return await runCorePipeline(deps, options, handler);
  } catch (error) {
    return handleApiError(error);
  }
}

export type ActionDeps = {
  getOrigin: () => string | null;
  getReferer: () => string | null;
  getMethod: () => string;
  getCsrfToken: () => string | null;
  getCookieToken: () => string | null;
  getAnonCookieToken: () => string | null;
  getContentType: () => string | null;
  parseJsonBody: () => Promise<unknown>;
  getSession: (token: string) => Promise<SessionData | null>;
  findUserById: (id: string) => Promise<User | null>;
};

export async function withAuthActionPipeline(
  deps: ActionDeps,
  options: PipelineOptions,
  handler: (ctx: PipelineContext) => Promise<Response>,
): Promise<Response> {
  try {
    return await runCorePipeline(deps, options, handler);
  } catch (error) {
    return handleApiError(error);
  }
}
