import { describe, expect, it } from 'vitest';
import { isRedacted, scanForSecrets, scanLine } from '@/lib/ops/log-scan';

describe('Phase 9 - log secret scan', () => {
  it('detects token-bearing URLs', () => {
    const findings = scanForSecrets('GET /verify-email?token=abc123 200');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, key: 'token' });
  });

  it('detects OAuth callback parameters', () => {
    const findings = scanForSecrets('GET /api/auth/oauth/google/callback?code=xyz&state=st&nonce=n1');
    expect(findings.map((f) => f.key).sort()).toEqual(['code', 'nonce', 'state']);
  });

  it('detects code_verifier by default', () => {
    const findings = scanLine('code_verifier=v', 3);
    expect(findings.map((f) => f.key)).toEqual(['code_verifier']);
    expect(findings.every((f) => f.line === 3)).toBe(true);
  });

  it('does not flag noisy credential keys by default', () => {
    // `password` / `secret` は設定例やフォーム項目名でも出るため既定では検出しない。
    expect(scanForSecrets('password=hidden secret=hidden api_key=hidden')).toEqual([]);
  });

  it('detects credential keys when opted in', () => {
    const findings = scanForSecrets('password=p secret=s', { includeCredentialKeys: true });
    expect(findings.map((f) => f.key).sort()).toEqual(['password', 'secret']);
  });

  it('never returns the secret value', () => {
    const secret = 'THIS_IS_THE_SECRET_VALUE';
    const findings = scanForSecrets(`GET /reset-password?token=${secret}`);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it('reports the correct line number', () => {
    const text = ['clean line', 'another clean line', 'GET /verify-email?token=abc'].join('\n');
    expect(scanForSecrets(text)[0]).toMatchObject({ line: 3, key: 'token' });
  });

  it('reports nothing for clean logs', () => {
    expect(scanForSecrets('GET /login 200 12ms\nPOST /api/auth/login 401')).toEqual([]);
  });

  it('deduplicates repeated keys on the same line', () => {
    expect(scanLine('token=a token=b', 1)).toHaveLength(1);
  });

  it('confirms the logger redacts these values', () => {
    expect(isRedacted('token=abc123')).toBe(true);
    expect(isRedacted('plain message')).toBe(false);
  });
});
