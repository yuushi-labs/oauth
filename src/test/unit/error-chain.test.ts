import { describe, expect, it } from 'vitest';
import { describeErrorChain } from '@/lib/util/error-chain';

/**
 * drizzle が真因を `cause` に隠す問題（BUG-21）への対処。CLI はこれを使って
 * 「Failed query」だけでなく接続失敗などの真因を出す。
 */
describe('describeErrorChain', () => {
  it('cause を連鎖して 1 つの文字列にする', () => {
    const root = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const wrapped = new Error('Failed query: insert into "roles"', { cause: root });
    expect(describeErrorChain(wrapped)).toBe(
      'Failed query: insert into "roles"\ncaused by: connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('falsy な cause（空文字）を取りこぼさない', () => {
    const wrapped = new Error('outer', { cause: '' });
    expect(describeErrorChain(wrapped)).toBe('outer\ncaused by: ');
  });

  it('falsy な cause（0 / false）も 1 行として残す', () => {
    expect(describeErrorChain(new Error('outer', { cause: 0 }))).toBe('outer\ncaused by: 0');
    expect(describeErrorChain(new Error('outer', { cause: false }))).toBe('outer\ncaused by: false');
  });

  it('Error でない値も文字列化する', () => {
    expect(describeErrorChain('plain failure')).toBe('plain failure');
  });

  it('深さの上限で打ち切る', () => {
    const e3 = new Error('level3');
    const e2 = new Error('level2', { cause: e3 });
    const e1 = new Error('level1', { cause: e2 });
    // maxDepth=1 なら先頭 2 行のみ。
    expect(describeErrorChain(e1, 1)).toBe('level1\ncaused by: level2');
  });

  it('cause が無ければ 1 行で終わる', () => {
    expect(describeErrorChain(new Error('solo'))).toBe('solo');
  });
});
