import { describe, expect, it } from 'vitest';
import { hashIp, maskIp } from '@/lib/util/ip';

describe('maskIp', () => {
  it('IPv4 は末尾を xxx にマスクする（仕様20）', () => {
    expect(maskIp('203.0.113.45')).toBe('203.0.113.xxx');
    expect(maskIp('192.168.1.10')).toBe('192.168.1.xxx');
  });

  it('IPv6 は前半のみ保持する', () => {
    expect(maskIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3:0:xxx');
    expect(maskIp('::1')).toBe('::xxx');
  });

  it('形式が不明でも例外にしない', () => {
    expect(maskIp('unknown')).toBe('unknown');
  });
});

describe('hashIp', () => {
  it('pepper 付き HMAC になる（生 IP を保存しない）', () => {
    const hash = hashIp('203.0.113.45', 'pepper');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashIp('203.0.113.45', 'pepper'));
    expect(hash).not.toContain('203.0.113.45');
  });

  it('pepper が異なれば hash も異なる', () => {
    expect(hashIp('203.0.113.45', 'pepper-a')).not.toBe(hashIp('203.0.113.45', 'pepper-b'));
  });
});