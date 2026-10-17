/* eslint-disable security/detect-non-literal-regexp, security/detect-object-injection --
   the regex and the lookups below are driven by the constant tables in this file, never by input. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * テーマトークンのコントラストを固定する（BUG-3 / BUG-4）。
 * - テキストペアは WCAG AA の 4.5:1 以上
 * - 非テキスト（フォーカスリング・入力欄の境界）は 3:1 以上
 * 値は globals.css の実測結果（docs/phase3 実装計画 §6.5）を基準にしている。
 */

const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

function parseTokens(selector: string): Record<string, string> {
  const escaped = selector.replace(/[[\]']/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  if (!block) throw new Error(`selector not found: ${selector}`);
  const tokens: Record<string, string> = {};
  for (const match of block[1]!.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1]!] = match[2]!;
  }
  return tokens;
}

const light = parseTokens(':root');
const dark = parseTokens("[data-theme='dark']");

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

const TEXT_PAIRS: [string, string][] = [
  ['--fg', '--bg'],
  ['--fg', '--card'],
  ['--muted-fg', '--bg'],
  ['--muted-fg', '--card'],
  ['--danger', '--bg'],
  ['--success', '--bg'],
  ['--warning', '--bg'],
  ['--primary', '--bg'],
  ['--primary-fg', '--primary'],
];

const NON_TEXT_PAIRS: [string, string][] = [
  ['--ring', '--bg'],
  ['--border-strong', '--card'],
];

const SOFT_PAIRS: [string, string][] = [
  ['--danger', '--danger-soft'],
  ['--success', '--success-soft'],
  ['--warning', '--warning-soft'],
];

const THEMES: [string, Record<string, string>][] = [
  ['light', light],
  ['dark', dark],
];

describe('theme token contrast (WCAG AA)', () => {
  it.each(THEMES)('%s テーマのテキストペアが 4.5:1 以上', (_name, tokens) => {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrast(tokens[foreground]!, tokens[background]!);
      expect(
        ratio,
        `${foreground} (${tokens[foreground]}) on ${background} (${tokens[background]}) = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s テーマの非テキスト境界が 3:1 以上', (_name, tokens) => {
    for (const [foreground, background] of NON_TEXT_PAIRS) {
      expect(contrast(tokens[foreground]!, tokens[background]!)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)('%s テーマの alert 背景ペアが 4.5:1 以上', (_name, tokens) => {
    for (const [foreground, background] of SOFT_PAIRS) {
      expect(contrast(tokens[foreground]!, tokens[background]!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('BUG-3: dark で --primary-fg は白ではなく暗色（従来 #fff だと 2.54:1 だった）', () => {
    expect(contrast('#ffffff', dark['--primary']!)).toBeLessThan(4.5);
    expect(contrast(dark['--primary-fg']!, dark['--primary']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('BUG-4: --border は card 境界に 3:1 未満。入力欄には --border-strong を使う', () => {
    expect(contrast(light['--border']!, light['--card']!)).toBeLessThan(3);
    expect(contrast(light['--border-strong']!, light['--card']!)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark['--border-strong']!, dark['--card']!)).toBeGreaterThanOrEqual(3);
  });
});