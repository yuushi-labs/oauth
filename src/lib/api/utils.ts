import { NextRequest, NextResponse } from 'next/server';
import { normalizeError, ok, type ApiErrorBody } from '@/lib/errors';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import { runCorePipeline } from '@/lib/auth/pipeline';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

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
  return request.cookies.get('__Host-auth_session')?.value ?? null;
}

export function failResponse(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
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
    getCsrfToken: () => request.headers.get('x-csrf-token'),
    getCookieToken: () => getCookieToken(request),
    getContentType: () => request.headers.get('content-type'),
    parseJsonBody: () => request.json(),
    getSession,
    findUserById,
  };

  return runCorePipeline(deps, options, handler);
}

export type ActionDeps = {
  getOrigin: () => string | null;
  getCsrfToken: () => string | null;
  getCookieToken: () => string | null;
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
  return runCorePipeline(deps, options, handler);
}