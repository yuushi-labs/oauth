import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §11.3 静的な検査（回帰防止）。実ブラウザ検証は Phase 8-B なので、ここではソースを走査して
 * 「抜け穴を作る改修」を固定する。
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

function read(relPath: string): string {
  return readFileSync(join(SRC, relPath), 'utf8');
}

const files = walk(SRC);
const rel = (file: string): string => relative(SRC, file);

describe('Static - 2FA pending-session escape hatches are exactly the intended set (D-33-08)', () => {
  it('denyTotpPending: false は許可された経路だけ', () => {
    const allowed = new Set([
      'app/api/auth/2fa/challenge/verify/route.ts',
      'app/api/auth/logout/route.ts',
      'app/api/auth/logout-all/route.ts',
      'app/api/auth/me/route.ts',
    ]);

    const found = new Set<string>();
    for (const file of files) {
      if (file.includes('/test/')) continue;
      const source = readFileSync(file, 'utf8');
      if (/denyTotpPending:\s*false/.test(source)) found.add(rel(file));
    }

    expect([...found].sort()).toEqual([...allowed].sort());
  });

  it('csrf ルートは withAuthPipeline を通さない（保留セッションでも読める）', () => {
    const source = read('app/api/auth/csrf/route.ts');
    expect(source).not.toContain('denyTotpPending');
    expect(source).toContain('getSession');
  });
});

describe('Static - TOTP secret is only returned by the setup route (D-33-20)', () => {
  it('handleSuccess({ ... secret ... }) は 2fa/setup だけ', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes('/test/')) continue;
      if (!file.includes('/app/api/')) continue;
      const source = readFileSync(file, 'utf8');
      // 応答本文に secret を含めるのは setup のみ
      if (/handleSuccess\([^)]*\bsecret\b/s.test(source) && !rel(file).endsWith('2fa/setup/route.ts')) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Static - client components do not import server-only TOTP modules (BUG-11)', () => {
  it('otpauth / qrcode / totp-crypto / totp-qr をクライアントから import しない', () => {
    const serverOnly = ['otpauth', 'qrcode', '@/lib/auth/totp-crypto', '@/lib/auth/totp-qr', '@/lib/auth/totp'];
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(source)) continue;
      for (const serverModule of serverOnly) {
        if (source.includes(`from '${serverModule}'`)) violations.push(`${rel(file)} imports ${serverModule}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('Static - login blocks unverified email (D-33-21 / T18)', () => {
  it('login/route.ts に emailVerified の判定がある', () => {
    const source = read('app/api/auth/login/route.ts');
    expect(source).toMatch(/emailVerified/);
    expect(source).toContain('EMAIL_NOT_VERIFIED');
  });
});

describe('Static - resend is unauthenticated (D-33-22 / T19)', () => {
  it('resend-verification/route.ts は requireAuth: false', () => {
    const source = read('app/api/auth/resend-verification/route.ts');
    expect(source).toMatch(/requireAuth:\s*false/);
  });
});
