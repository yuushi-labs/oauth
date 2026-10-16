import { NextRequest } from 'next/server';
import { runCorePipeline } from '@/lib/auth/pipeline';
import { getSession } from '@/lib/auth/session';
import { findUserById } from '@/lib/db/queries/users';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';
import { getAnonCookieName, getSessionCookieName } from '@/lib/auth/cookie';

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
    getCookieToken: () => request.cookies.get(getSessionCookieName())?.value ?? null,
    getAnonCookieToken: () => request.cookies.get(getAnonCookieName())?.value ?? null,
    getContentType: () => request.headers.get('content-type'),
    parseJsonBody: () => request.json(),
    getSession,
    findUserById,
  };

  return runCorePipeline(deps, options, handler);
}
