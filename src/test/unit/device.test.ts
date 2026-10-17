import { describe, expect, it } from 'vitest';
import { deriveDeviceName, deriveOsLabel, MAX_DEVICE_NAME } from '@/lib/util/device';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

describe('deriveDeviceName (spec 19)', () => {
  it('Windows の Chrome', () => {
    expect(deriveDeviceName(CHROME_WINDOWS)).toBe('Chrome on Windows');
  });

  it('Linux の Firefox', () => {
    expect(deriveDeviceName(FIREFOX_LINUX)).toBe('Firefox on Linux');
  });

  it('iPhone / iPad は端末名', () => {
    expect(deriveDeviceName(SAFARI_IPHONE)).toBe('iPhone');
    expect(deriveDeviceName(SAFARI_IPAD)).toBe('iPad');
  });

  it('Android は OS とモデル', () => {
    const name = deriveDeviceName(CHROME_ANDROID);
    expect(name).toContain('Android');
    expect(name).toContain('Pixel 8');
  });

  it('空・空白・判定不能は「その他のデバイス」', () => {
    expect(deriveDeviceName('')).toBe('その他のデバイス');
    expect(deriveDeviceName('   ')).toBe('その他のデバイス');
    expect(deriveDeviceName(null)).toBe('その他のデバイス');
    expect(deriveDeviceName(undefined)).toBe('その他のデバイス');
    expect(deriveDeviceName('curl/8.4.0')).toBe('その他のデバイス');
  });

  it('制御文字を除去してから判定する', () => {
    const name = deriveDeviceName('Chrome\u0007\u001fon Windows');
    expect(name).not.toMatch(/[\u0000-\u001F\u007F]/);
  });

  it('120 文字で切り詰める（通知メール本文に載るため）', () => {
    const long = `Mozilla/5.0 (${'a'.repeat(500)}) Chrome/1.0`;
    expect(deriveDeviceName(long).length).toBeLessThanOrEqual(MAX_DEVICE_NAME);
  });
});

describe('deriveOsLabel', () => {
  it('OS 名とバージョンを返す', () => {
    expect(deriveOsLabel(CHROME_WINDOWS)).toMatch(/^Windows/);
    expect(deriveOsLabel(SAFARI_IPHONE)).toMatch(/^iOS/);
  });

  it('判定できなければ null', () => {
    expect(deriveOsLabel('')).toBeNull();
    expect(deriveOsLabel('curl/8.4.0')).toBeNull();
  });
});