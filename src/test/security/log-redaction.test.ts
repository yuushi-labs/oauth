import { describe, expect, it, vi, beforeEach } from 'vitest';
import { redact, redactText, logger } from '@/lib/util/logger';

describe('Security - Log Redaction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('redact masks password in object', () => {
    const obj = { password: 'secret123', username: 'user' };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.password).toBe('***');
    expect(result.username).toBe('user');
  });

  it('redact masks token in object', () => {
    const obj = { token: 'abc123', data: 'value' };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.token).toBe('***');
    expect(result.data).toBe('value');
  });

  it('redact masks authorization in object', () => {
    const obj = { authorization: 'Bearer xyz', normal: 'value' };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.authorization).toBe('***');
  });

  it('redact masks cookie in object', () => {
    const obj = { cookie: 'session=abc123', other: 'value' };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.cookie).toBe('***');
  });

  it('redact masks pepper in object', () => {
    const obj = { pepper: 'secret', public: 'value' };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.pepper).toBe('***');
  });

  it('redactText masks key=value patterns in strings', () => {
    const input = 'password=secret123&token=abc456';
    const result = redactText(input);
    expect(result).toContain('password=***');
    expect(result).toContain('token=***');
    expect(result).not.toContain('secret123');
    expect(result).not.toContain('abc456');
  });

  it('redactText masks code_verifier in strings', () => {
    const input = 'code_verifier=verifier123&state=state123';
    const result = redactText(input);
    expect(result).toContain('code_verifier=***');
    expect(result).toContain('state=***');
  });

  it('redact handles nested objects', () => {
    const obj = {
      user: { password: 'secret', name: 'John' },
      token: 'abc123',
    };
    const result = redact(obj) as Record<string, unknown>;
    expect((result.user as Record<string, unknown>).password).toBe('***');
    expect((result.user as Record<string, unknown>).name).toBe('John');
    expect(result.token).toBe('***');
  });

  it('redact handles arrays of objects', () => {
    const obj = { 
      users: [{ password: 'secret1', name: 'A' }, { password: 'secret2', name: 'B' }],
      public: 'value' 
    };
    const result = redact(obj) as Record<string, unknown>;
    expect((result.users as unknown[])[0]).toEqual({ password: '***', name: 'A' });
    expect((result.users as unknown[])[1]).toEqual({ password: '***', name: 'B' });
  });
});