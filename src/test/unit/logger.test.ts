import { describe, expect, it, vi } from 'vitest';
import { REDACTED, isSensitiveKey, redact, redactText, logger } from '@/lib/util/logger';

describe('isSensitiveKey', () => {
  it('秘密情報のキーを判定する（仕様45）', () => {
    for (const key of [
      'password',
      'password_hash',
      'token',
      'sessionToken',
      'access_token',
      'refreshToken',
      'clientSecret',
      'totpSecret',
      'recoveryCode',
      'csrfToken',
      'authorization',
      'SESSION_PEPPER',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('秘密情報でないキーは false', () => {
    for (const key of ['userId', 'username', 'email', 'deviceName', 'ipMasked']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactText', () => {
  it('URL 中の token を伏せる', () => {
    expect(redactText('GET /verify-email?token=abc123&x=1')).toBe(
      `GET /verify-email?token=${REDACTED}&x=1`,
    );
  });

  it('code_verifier / password / secret も伏せる', () => {
    expect(redactText('code_verifier=xyz')).toBe(`code_verifier=${REDACTED}`);
    expect(redactText('password=hunter2')).toBe(`password=${REDACTED}`);
    expect(redactText('client_secret=shhh')).toBe(`client_secret=${REDACTED}`);
  });

  it('該当なしはそのまま', () => {
    expect(redactText('user logged in')).toBe('user logged in');
  });
});

describe('redact', () => {
  it('オブジェクトの秘密キーを伏せる', () => {
    const result = redact({
      userId: 'usr_1',
      password: 'hunter2',
      nested: { totpSecret: 'ABC', deviceName: 'Chrome on Windows' },
      list: [{ sessionToken: 'sess_x' }],
    });

    expect(result).toEqual({
      userId: 'usr_1',
      password: REDACTED,
      nested: { totpSecret: REDACTED, deviceName: 'Chrome on Windows' },
      list: [{ sessionToken: REDACTED }],
    });
  });

  it('文字列値の中の token= も伏せる', () => {
    expect(redact({ url: 'https://example.com/reset?token=xyz' })).toEqual({
      url: `https://example.com/reset?token=${REDACTED}`,
    });
  });

  it('深すぎる入れ子は丸める', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 10; i += 1) {
      deep = { nested: deep };
    }
    expect(JSON.stringify(redact(deep))).toContain(REDACTED);
  });
});

describe('logger', () => {
  it('シークレットを出力しない', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.info('login attempt', { email: 'user@example.com', password: 'hunter2' });

    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).not.toContain('hunter2');
    expect(line).toContain(REDACTED);
    expect(line).toContain('user@example.com');
    spy.mockRestore();
  });

  it('メッセージ本文の token も伏せる', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('failed: https://x.test/verify?token=raw-token-value');

    expect(String(spy.mock.calls[0]?.[0])).not.toContain('raw-token-value');
    spy.mockRestore();
  });
});