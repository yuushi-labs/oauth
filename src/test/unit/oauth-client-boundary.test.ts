import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BUG-11 の再発防止: `process.env` を読むサーバーコンポーネントを、
 * **クライアントコンポーネントから import してはいけない**。
 *
 * `'use client'` のファイルがサーバー専用モジュールを import すると、そのファイルは
 * クライアントバンドルに丸ごと取り込まれる。ブラウザには `process.env` が無く、
 * サーバーでは 1 件・クライアントでは 0 件という**描画差**になり、
 * hydration mismatch（BUG-11）が起きる。
 *
 * Playwright による実ブラウザ検証は Phase 8-B なので、ここでは静的に検査する。
 */

const SRC = join(process.cwd(), 'src');

/** クライアント側で読むと壊れるサーバー専用モジュール。 */
const SERVER_ONLY_MODULES = [
  '@/lib/auth/oauth/registry',
  '@/lib/env',
  '@/lib/auth/oauth/state',
  '@/lib/auth/oauth/accounts',
  '@/lib/auth/oauth/complete-login',
  '@/lib/auth/oauth/complete-link',
  '@/lib/auth/oauth/redirect-uri',
  '@/lib/db/schema',
  '@/lib/db/client',
  // Passkey / WebAuthn（Phase 6・BUG-11 の再発防止）。`config.ts` は `getEnv()` を、
  // `queries/webauthn` は DB を参照するためクライアントから import してはいけない。
  '@/lib/auth/passkey/config',
  '@/lib/auth/passkey/registration',
  '@/lib/auth/passkey/authentication',
  '@/lib/db/queries/webauthn',
];

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe('Boundary - client components must not import server-only modules', () => {
  const files = walk(SRC);

  it('finds the source tree (guard against a silently empty scan)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no client component importing a server-only module', () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(source)) continue;

      for (const serverModule of SERVER_ONLY_MODULES) {
        if (source.includes(`from '${serverModule}'`)) {
          violations.push(`${file.replace(SRC, 'src')} imports ${serverModule}`);
        }
      }
      // process.env の直接参照もクライアント側では値が壊れる
      if (/process\.env\.[A-Z_]/.test(source)) {
        violations.push(`${file.replace(SRC, 'src')} reads process.env directly`);
      }
    }

    expect(violations).toEqual([]);
  });
});