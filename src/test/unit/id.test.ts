import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isIdPrefix, newId, parseId } from '@/lib/util/id';

describe('newId', () => {
  it('prefix 付きの ID を生成する', () => {
    const id = newId('usr');
    expect(id.startsWith('usr_')).toBe(true);
    expect(id.slice('usr_'.length)).toHaveLength(26);
  });

  it('生成される ID は一意である', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('ses')));
    expect(ids.size).toBe(1000);
  });

  it('定義済み prefix をすべて受け付ける', () => {
    for (const prefix of ID_PREFIXES) {
      expect(isIdPrefix(prefix)).toBe(true);
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });
});

describe('isIdPrefix', () => {
  it('未定義の prefix を拒否する', () => {
    expect(isIdPrefix('app')).toBe(false);
    expect(isIdPrefix('')).toBe(false);
  });
});

describe('parseId', () => {
  it('prefix と ULID に分解できる', () => {
    const parsed = parseId(newId('acc'));
    expect(parsed.prefix).toBe('acc');
    expect(parsed.ulid).toHaveLength(26);
  });

  it('期待する prefix が違う場合は throw する', () => {
    expect(() => parseId(newId('usr'), 'ses')).toThrow(/期待しないID prefix/);
  });

  it('不正な形式を拒否する', () => {
    expect(() => parseId('usr')).toThrow(/不正なID形式/);
    expect(() => parseId('_01J')).toThrow(/不正なID形式/);
    expect(() => parseId('usr_')).toThrow(/不正なID形式/);
    expect(() => parseId('app_01J0000000000000000000000')).toThrow(/不正なID prefix/);
    expect(() => parseId('usr_short')).toThrow(/不正なULID/);
  });
});