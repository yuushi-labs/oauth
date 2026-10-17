import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildAuthorizeUrl,
  createClientTestState,
  decryptClientTestSecret,
  getClientTestCookieName,
  readClientTestState,
} from '@/lib/oidc/client-test';

const baseInput = {
  clientId: 'cli_test',
  sessionId: 'ses_owner',
  redirectUri: 'https://auth.example/settings/applications/test/callback',
  scopes: ['openid', 'email'],
};

describe('Connection test state cookie', () => {
  it('round-trips the PKCE state for the issuing session', () => {
    const { value, state } = createClientTestState({ ...baseInput, clientSecret: 'sec_plain' });
    const restored = readClientTestState(value, 'ses_owner');
    expect(restored).not.toBeNull();
    expect(restored?.clientId).toBe('cli_test');
    expect(restored?.state).toBe(state.state);
    expect(restored?.codeVerifier).toBe(state.codeVerifier);
    expect(decryptClientTestSecret(restored!)).toBe('sec_plain');
  });

  it('never stores the plaintext secret in the cookie', () => {
    const { value } = createClientTestState({ ...baseInput, clientSecret: 'sec_supersecret' });
    expect(value).not.toContain('sec_supersecret');
    expect(Buffer.from(value.split('.')[0] ?? '', 'base64url').toString('utf8')).not.toContain('sec_supersecret');
  });

  it('rejects a tampered, truncated or unsigned cookie', () => {
    const { value } = createClientTestState({ ...baseInput, clientSecret: null });
    const [payload, signature] = value.split('.');
    expect(readClientTestState(`${payload}x.${signature}`, 'ses_owner')).toBeNull();
    expect(readClientTestState(`${payload}.${signature}x`, 'ses_owner')).toBeNull();
    expect(readClientTestState(payload ?? '', 'ses_owner')).toBeNull();
    expect(readClientTestState(undefined, 'ses_owner')).toBeNull();
  });

  it('binds the state to the issuing session', () => {
    const { value } = createClientTestState({ ...baseInput, clientSecret: null });
    expect(readClientTestState(value, 'ses_other')).toBeNull();
  });

  it('expires the state after ten minutes', () => {
    const { value } = createClientTestState({ ...baseInput, clientSecret: null });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);
    expect(readClientTestState(value, 'ses_owner')).toBeNull();
    vi.useRealTimers();
  });

  it('builds a PKCE S256 authorization request with state and nonce', () => {
    const { state } = createClientTestState({ ...baseInput, clientSecret: null });
    const url = new URL(buildAuthorizeUrl(state, 'https://auth.example'));
    expect(url.origin + url.pathname).toBe('https://auth.example/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cli_test');
    expect(url.searchParams.get('redirect_uri')).toBe(baseInput.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(state.codeVerifier).digest('base64url'),
    );
    expect(url.searchParams.get('state')).toBe(state.state);
    expect(url.searchParams.get('nonce')).toBe(state.nonce);
    expect(url.searchParams.get('scope')).toBe('openid email');
  });

  it('uses a __Host- prefixed cookie name in production', () => {
    expect(getClientTestCookieName()).toBe('auth_oidc_test');
  });
});
