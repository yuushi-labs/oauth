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

  it('redact masks OAuth secrets as object keys', () => {
    const obj = {
      code: 'auth-code',
      state: 'state-value',
      nonce: 'nonce-value',
      code_verifier: 'verifier-value',
      id_token: 'header.payload.signature',
      access_token: 'at-value',
      provider: 'google',
    };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.code).toBe('***');
    expect(result.state).toBe('***');
    expect(result.nonce).toBe('***');
    expect(result.code_verifier).toBe('***');
    expect(result.id_token).toBe('***');
    expect(result.access_token).toBe('***');
    // provider 名は機密値ではないので残る（観測可能性のため）
    expect(result.provider).toBe('google');
  });

  it('redact masks TOTP / recovery secrets as object keys (D-33-20)', () => {
    const obj = {
      secret: 'JBSWY3DPEHPK3PXP',
      secret_encrypted: 'v1.abc.def.ghi',
      otpauth_uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      recovery_codes: ['AAAAA-BBBBB-CCCCC-DDDDD'],
      recovery_code: 'AAAAA-BBBBB-CCCCC-DDDDD',
      qr_svg: '<svg/>',
      enabled: true,
    };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.secret).toBe('***');
    expect(result.secret_encrypted).toBe('***');
    expect(result.otpauth_uri).toBe('***');
    expect(result.recovery_codes).toBe('***');
    expect(result.recovery_code).toBe('***');
    expect(result.qr_svg).toBe('***');
    // 機密でないフラグは残る
    expect(result.enabled).toBe(true);
  });

  it('redact masks OAuth query parameters inside a callback URL', () => {
    const input =
      '/api/auth/oauth/google/callback?code=abc123&state=st456&nonce=no789&code_verifier=v012&error_description=denied';
    const result = redactText(input);
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('st456');
    expect(result).not.toContain('no789');
    expect(result).not.toContain('v012');
    expect(result).toContain('code=***');
    expect(result).toContain('state=***');
    expect(result).toContain('nonce=***');
    expect(result).toContain('code_verifier=***');
    // そのまま ternary 扱いしていた他の値は消さない
    expect(result).toContain('error_description=denied');
  });

  it('redact masks id_token in a bare string', () => {
    const result = redactText('id_token=eyJhbGciOiJSUzI1NiJ9.payload.sig');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
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
  it('redact masks Passkey / WebAuthn values as object keys（D-34-14）', () => {
    const obj = {
      credentialId: 'cred-abc',
      publicKey: 'cHVia2V5',
      attestationObject: 'o2NmbXQ',
      authenticatorData: 'SZYN5YgO',
      clientDataJSON: 'eyJ0eXBl',
      signature: 'MEUCIQ',
      challenge: 'chal-abc',
      // 機密でないフィールドは残る
      deviceName: 'MacBook の Touch ID',
      signCount: 5,
    };
    const result = redact(obj) as Record<string, unknown>;
    expect(result.credentialId).toBe('***');
    expect(result.publicKey).toBe('***');
    expect(result.attestationObject).toBe('***');
    expect(result.authenticatorData).toBe('***');
    expect(result.clientDataJSON).toBe('***');
    expect(result.signature).toBe('***');
    expect(result.challenge).toBe('***');
    expect(result.deviceName).toBe('MacBook の Touch ID');
    expect(result.signCount).toBe(5);
  });

  it('redactText masks argon2 password hashes embedded in DB error messages', () => {
    const input =
      'Failed query: insert into "users" ... params: usr_1,user,user@example.com,false,'
      + '$argon2id$v=19$m=65536,t=3,p=4$FMsGOawt+ruw4dI+paVGNw$QgJlmaSCopYpvpx6RU91Wp+tO1U2rQf0I20rKqTsdSk,pending_email,role_user';
    const result = redactText(input);
    expect(result).not.toContain('$argon2id$');
    expect(result).not.toContain('QgJlmaSCopYpvpx6RU91Wp');
    expect(result).toContain('***');
  });
});
