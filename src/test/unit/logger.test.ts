import { describe, expect, it, vi } from 'vitest';
import { REDACTED, isSensitiveKey, redact, redactText, logger } from '@/lib/util/logger';
import { normalizeRequestId, runWithRequestId } from '@/lib/util/request-context';

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

  it('runWithRequestId のスコープ内では requestId を付ける（P9-04）', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    runWithRequestId('req-abc-12345678', () => {
      logger.info('scoped log');
    });

    const payload = JSON.parse(String(spy.mock.calls[0]?.[0])) as { requestId?: string };
    expect(payload.requestId).toBe('req-abc-12345678');
    spy.mockRestore();
  });

  it('スコープ外のログには requestId を付けない', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.info('unscoped log');

    const payload = JSON.parse(String(spy.mock.calls[0]?.[0])) as { requestId?: string };
    expect(payload.requestId).toBeUndefined();
    spy.mockRestore();
  });
});

describe('normalizeRequestId', () => {
  it('妥当な ID はそのまま通し、前後の空白を落とす', () => {
    expect(normalizeRequestId('  abc12345-ab_cd  ')).toBe('abc12345-ab_cd');
  });

  it('短すぎる・長すぎる・不正文字は null（採番に委ねる）', () => {
    expect(normalizeRequestId('short')).toBeNull();
    expect(normalizeRequestId('a'.repeat(65))).toBeNull();
    expect(normalizeRequestId('bad id with spaces')).toBeNull();
    expect(normalizeRequestId('<script>alert(1)</script>')).toBeNull();
    expect(normalizeRequestId(null)).toBeNull();
    expect(normalizeRequestId(undefined)).toBeNull();
  });
});