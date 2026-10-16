import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCorePipeline, deriveCsrfToken, type CorePipelineDeps } from '@/lib/auth/pipeline';
import type { SessionData } from '@/lib/auth/session';
import type { User } from '@/lib/db/schema';

afterEach(() => vi.unstubAllEnvs());

describe('Phase 2 IDOR boundary', () => {
  it('uses the authenticated session user even when the body names another user', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'https://app.example');
    const session = { id: 'ses_owner', userId: 'usr_owner', csrfSecret: 'session-csrf-secret' } as SessionData;
    const user = { id: 'usr_owner', email: 'owner@example.com' } as User;
    const deps: CorePipelineDeps = {
      getMethod: () => 'POST',
      getOrigin: () => 'https://app.example',
      getReferer: () => null,
      getCsrfToken: () => deriveCsrfToken(session),
      getCookieToken: () => 'session-token',
      getAnonCookieToken: () => null,
      getContentType: () => 'application/json',
      parseJsonBody: async () => ({ user_id: 'usr_victim', action: 'change' }),
      getSession: vi.fn(async () => session),
      findUserById: vi.fn(async () => user),
    };
    let actor: string | undefined;
    const response = await runCorePipeline(deps, { requireAuth: true }, async ({ user: actorUser }) => {
      actor = actorUser?.id;
      return new Response(null, { status: 204 });
    });
    expect(response.status).toBe(204);
    expect(actor).toBe('usr_owner');
    expect(deps.findUserById).toHaveBeenCalledWith('usr_owner');
  });
});
