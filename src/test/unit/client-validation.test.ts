import { describe, expect, it } from 'vitest';
import {
  ClientValidationError,
  connectionTestRedirectUri,
  isRegisteredRedirectUri,
  parseClientInput,
  parseClientUpdateInput,
  parseScopes,
  requireWebOriginForPublicClient,
  validateRedirectUri,
  validateWebOrigin,
} from '@/lib/oidc/client-validation';

const validInput = {
  name: 'My Service',
  operator: 'My Service株式会社',
  clientType: 'confidential',
  redirectUris: ['https://service.example/callback'],
  scopes: ['openid', 'profile', 'email'],
  webOrigins: [],
};

describe('OIDC client input validation', () => {
  it('accepts a confidential client with an https redirect URI', () => {
    const parsed = parseClientInput(validInput);
    expect(parsed.redirectUris).toEqual(['https://service.example/callback']);
    expect(parsed.scopes).toEqual(['openid', 'profile', 'email']);
    expect(parsed.webOrigins).toEqual([]);
  });

  it('deduplicates and trims redirect URIs', () => {
    const parsed = parseClientInput({
      ...validInput,
      redirectUris: [' https://service.example/callback ', 'https://service.example/callback'],
    });
    expect(parsed.redirectUris).toHaveLength(1);
  });

  it('rejects non-https redirect URIs except loopback', () => {
    expect(() => validateRedirectUri('http://service.example/callback')).toThrow(ClientValidationError);
    expect(validateRedirectUri('http://localhost:3000/callback')).toBe('http://localhost:3000/callback');
    expect(validateRedirectUri('http://127.0.0.1:8080/cb')).toBe('http://127.0.0.1:8080/cb');
  });

  it('rejects redirect URIs with credentials, fragments or unsupported schemes', () => {
    expect(() => validateRedirectUri('https://user:pw@service.example/cb')).toThrow(ClientValidationError);
    expect(() => validateRedirectUri('https://service.example/cb#token')).toThrow(ClientValidationError);
    expect(() => validateRedirectUri('javascript:alert(1)')).toThrow(ClientValidationError);
    expect(() => validateRedirectUri('https://service.example/cb')).not.toThrow();
  });

  it('requires at least one redirect URI', () => {
    expect(() => parseClientInput({ ...validInput, redirectUris: [] })).toThrow(ClientValidationError);
  });

  it('requires openid and rejects scopes outside the allowlist', () => {
    expect(() => parseScopes(['profile', 'email'])).toThrow(ClientValidationError);
    expect(() => parseScopes(['openid', 'offline_access'])).toThrow(ClientValidationError);
    expect(parseScopes('openid,profile')).toEqual(['openid', 'profile']);
  });

  it('rejects control characters in the name and operator shown on the consent screen', () => {
    expect(() => parseClientInput({ ...validInput, name: 'evil<script>' })).not.toThrow();
    expect(() => parseClientInput({ ...validInput, name: 'evil\nalert' })).toThrow(ClientValidationError);
    expect(() => parseClientInput({ ...validInput, operator: '運営者\r\nX-Injected: 1' })).toThrow(ClientValidationError);
    expect(() => parseClientInput({ ...validInput, name: '' })).toThrow(ClientValidationError);
    expect(() => parseClientInput({ ...validInput, operator: 'x'.repeat(101) })).toThrow(ClientValidationError);
  });

  it('rejects web origins on confidential clients and validates origin shape', () => {
    expect(() => parseClientInput({ ...validInput, webOrigins: ['https://service.example'] })).toThrow(ClientValidationError);
    expect(validateWebOrigin('https://service.example')).toBe('https://service.example');
    expect(() => validateWebOrigin('https://service.example/callback')).toThrow(ClientValidationError);
    expect(() => validateWebOrigin('http://service.example')).toThrow(ClientValidationError);
    expect(validateWebOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('enforces the console-only web origin rule for public clients', () => {
    expect(() => requireWebOriginForPublicClient('public', [])).toThrow(ClientValidationError);
    expect(() => requireWebOriginForPublicClient('public', ['https://spa.example'])).not.toThrow();
    expect(() => requireWebOriginForPublicClient('confidential', [])).not.toThrow();
  });

  it('keeps client_type immutable on update while still validating the rest', () => {
    const parsed = parseClientUpdateInput({
      name: 'Renamed',
      operator: 'Operator',
      redirectUris: ['https://service.example/callback'],
      scopes: ['openid'],
      webOrigins: [],
    }, 'confidential');
    expect(parsed).not.toHaveProperty('clientType');
    expect(parsed.name).toBe('Renamed');
    expect(() => parseClientUpdateInput({ ...validInput, clientType: 'public' }, 'confidential')).not.toThrow();
    expect(() => parseClientUpdateInput({ ...validInput, redirectUris: ['http://evil.example/cb'] }, 'confidential')).toThrow(ClientValidationError);
  });

  it('derives the connection test redirect URI from the fixed app origin', () => {
    expect(connectionTestRedirectUri('https://auth.example')).toBe('https://auth.example/settings/applications/test/callback');
    expect(connectionTestRedirectUri('https://auth.example/base/')).toBe('https://auth.example/settings/applications/test/callback');
    expect(isRegisteredRedirectUri(['https://auth.example/settings/applications/test/callback'], 'https://auth.example/settings/applications/test/callback')).toBe(true);
    expect(isRegisteredRedirectUri(['https://auth.example/settings/applications/test/callback'], 'https://auth.example/settings/applications/test/callback2')).toBe(false);
  });
});
