// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordSecurityEvent, logger } = vi.hoisted(() => ({
  recordSecurityEvent: vi.fn(async () => undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent }));
vi.mock('@/lib/util/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/util/logger')>('@/lib/util/logger');
  return { ...actual, logger };
});

import { attachOidcSecurityEvents } from '@/lib/oidc/events';

type Listener = (ctx: unknown, error?: unknown) => void;

function fakeProvider() {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    on: (event: string, listener: Listener) => listeners.set(event, listener),
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    req: {
      headers: { 'user-agent': 'vitest-agent' },
      socket: { remoteAddress: '203.0.113.9' },
    },
    oidc: { client: { clientId: 'cli_1' }, session: { accountId: 'usr_1' } },
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('Security - OIDC security event wiring', () => {
  beforeEach(() => {
    recordSecurityEvent.mockClear();
    logger.error.mockClear();
  });

  it('token / userinfo / revocation / authorization の失敗をイベントとして記録する', async () => {
    const provider = fakeProvider();
    attachOidcSecurityEvents(provider);

    provider.listeners.get('grant.error')?.(ctx(), { error: 'invalid_grant', error_description: 'code expired' });
    provider.listeners.get('userinfo.error')?.(ctx(), { error: 'invalid_token' });
    provider.listeners.get('revocation.error')?.(ctx(), { error: 'invalid_client' });
    provider.listeners.get('authorization.error')?.(ctx(), { error: 'access_denied' });
    await flush();

    const recorded = recordSecurityEvent.mock.calls.map(([type, userId, ip, ua, metadata]) => ({ type, userId, ip, ua, metadata }));
    expect(recorded.map((call) => call.type)).toEqual([
      'oidc_token_failed', 'oidc_token_failed', 'oidc_token_failed', 'oidc_authorize_denied',
    ]);
    expect(recorded[0]).toMatchObject({ userId: 'usr_1', ip: '203.0.113.9', ua: 'vitest-agent' });
    expect(recorded[0].metadata).toMatchObject({ endpoint: 'token', clientId: 'cli_1', oauthError: 'invalid_grant' });
    expect(recorded[3].metadata).toMatchObject({ endpoint: 'authorize' });
  });

  it('grant.revoked を oidc_token_revoked として記録する', async () => {
    const provider = fakeProvider();
    attachOidcSecurityEvents(provider);

    provider.listeners.get('grant.revoked')?.(ctx(), 'gra_1');
    await flush();

    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent.mock.calls[0][0]).toBe('oidc_token_revoked');
    expect(recordSecurityEvent.mock.calls[0][4]).toMatchObject({ endpoint: 'revoke' });
  });

  it('token / code / secret を metadata に残さない', async () => {
    const provider = fakeProvider();
    attachOidcSecurityEvents(provider);

    provider.listeners.get('grant.error')?.(ctx(), {
      error: 'invalid_grant',
      error_description: 'code=super-secret-code client_secret=sec_leak',
      access_token: 'at_leak',
      code: 'code_leak',
    });
    await flush();

    const metadata = recordSecurityEvent.mock.calls[0][4];
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('sec_leak');
    expect(serialized).not.toContain('code_leak');
    expect(serialized).not.toContain('at_leak');
    expect(metadata.oauthError).toBe('invalid_grant');
  });

  it('記録に失敗しても OIDC 処理の応答は止めない', async () => {
    recordSecurityEvent.mockRejectedValueOnce(new Error('database unavailable'));
    const provider = fakeProvider();
    attachOidcSecurityEvents(provider);

    expect(() => provider.listeners.get('grant.error')?.(ctx(), { error: 'invalid_grant' })).not.toThrow();
    await flush();
    expect(logger.error).toHaveBeenCalled();
  });
});