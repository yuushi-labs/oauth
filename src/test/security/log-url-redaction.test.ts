import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/util/logger';

/**
 * アプリ側ログの URL redaction（Phase 9 / P9-08e・§17.2.1）。
 *
 * 認証トークン付き URL を `logger` が平文で出さないことを固定する。外側の層
 * （reverse proxy / CDN / tracing）の対策は `deploy/log-security-checklist.md` を参照。
 */

const captured: string[] = [];

beforeEach(() => {
  captured.length = 0;
  vi.spyOn(console, 'log').mockImplementation((line: string) => captured.push(line));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => captured.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => captured.push(line));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase 9 - auth URL redaction', () => {
  it('redacts the email verification token in a URL', () => {
    logger.info('request /verify-email?token=SECRET-VERIFY-TOKEN');
    expect(captured.join('\n')).not.toContain('SECRET-VERIFY-TOKEN');
    expect(captured.join('\n')).toContain('token=***');
  });

  it('redacts the password reset token in a URL', () => {
    logger.info('GET /reset-password?token=SECRET-RESET-TOKEN 200');
    expect(captured.join('\n')).not.toContain('SECRET-RESET-TOKEN');
  });

  it('redacts OAuth callback code/state/nonce in a URL', () => {
    logger.info('GET /api/auth/oauth/google/callback?code=SECRET-CODE&state=SECRET-STATE&nonce=SECRET-NONCE');
    const output = captured.join('\n');
    expect(output).not.toContain('SECRET-CODE');
    expect(output).not.toContain('SECRET-STATE');
    expect(output).not.toContain('SECRET-NONCE');
  });

  it('redacts code_verifier in a URL', () => {
    logger.info('POST /oauth2/token?code_verifier=SECRET-VERIFIER');
    expect(captured.join('\n')).not.toContain('SECRET-VERIFIER');
  });

  it('redacts the value when the URL is inside metadata', () => {
    logger.error('failed', { url: 'https://app.example/reset-password?token=SECRET-META-TOKEN' });
    expect(captured.join('\n')).not.toContain('SECRET-META-TOKEN');
  });

  it('redacts on every log level', () => {
    logger.debug('/verify-email?token=SECRET-D');
    logger.info('/verify-email?token=SECRET-I');
    logger.warn('/verify-email?token=SECRET-W');
    logger.error('/verify-email?token=SECRET-E');
    const output = captured.join('\n');
    for (const secret of ['SECRET-D', 'SECRET-I', 'SECRET-W', 'SECRET-E']) {
      expect(output).not.toContain(secret);
    }
  });

  it('does not alter a clean URL', () => {
    logger.info('GET /login 200');
    expect(captured.join('\n')).toContain('/login 200');
  });
});
