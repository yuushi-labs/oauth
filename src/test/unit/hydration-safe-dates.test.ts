import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BUG-23: React error #418（Hydration failed … text didn't match）。
 *
 * `Date#toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` は server と
 * client でタイムゾーン・ICU が異なり、SSR されたテキストと hydration 時のテキストが
 * 食い違って #418 になる。日時は `formatLocalDateTime`（§60 / D-30-17）を使う。
 *
 * クライアントから到達しうる `src/app` / `src/components` のソースを走査し、
 * これら locale 依存 API の再混入を防ぐ。
 */
const LOCALE_DATE_API = /\.toLocale(String|DateString|TimeString)\(/;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectSourceFiles(full));
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('hydration-safe date formatting (BUG-23)', () => {
  it('src/app と src/components に locale 依存の日時整形が無い', () => {
    const roots = [resolve(process.cwd(), 'src/app'), resolve(process.cwd(), 'src/components')];
    const offenders = roots
      .flatMap(collectSourceFiles)
      .filter((file) => LOCALE_DATE_API.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(`${process.cwd()}/`, ''));

    expect(offenders, 'formatLocalDateTime を使ってください').toEqual([]);
  });
});
