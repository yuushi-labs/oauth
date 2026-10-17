import { UAParser } from 'ua-parser-js';

/**
 * デバイス名の生成（§19 / 計画 D-12）。
 * 例: `Chrome on Windows` / `iPhone` / `その他のデバイス`。
 * 通知メール本文と設定画面の両方に出るため、長さと文字種を制限する。
 */
const MAX_DEVICE_NAME = 120;
const FALLBACK_DEVICE_NAME = 'その他のデバイス';
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function clean(userAgent: string | null | undefined): string {
  return (userAgent ?? '').replace(CONTROL_CHARS, '').slice(0, 512);
}

function truncate(value: string): string {
  return value.length <= MAX_DEVICE_NAME ? value : value.slice(0, MAX_DEVICE_NAME);
}

export function deriveDeviceName(userAgent: string | null | undefined): string {
  const ua = clean(userAgent);
  if (!ua.trim()) return FALLBACK_DEVICE_NAME;

  // Apple 端末は UA の表記ゆれが大きいため先に確定する
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPod/i.test(ua)) return 'iPod';

  const { browser, device, os } = new UAParser(ua).getResult();

  if (device.model) {
    const label = [os.name, String(device.model)].filter(Boolean).join(' ');
    if (label) return truncate(label);
  }

  if (!browser.name && !os.name) return FALLBACK_DEVICE_NAME;
  return truncate(
    [browser.name ?? 'ブラウザ不明', os.name ? `on ${os.name}` : ''].filter(Boolean).join(' '),
  );
}

export function deriveOsLabel(userAgent: string | null | undefined): string | null {
  const ua = clean(userAgent);
  if (!ua.trim()) return null;
  const { os } = new UAParser(ua).getResult();
  if (!os.name) return null;
  return os.version ? `${os.name} ${os.version}` : os.name;
}

export { FALLBACK_DEVICE_NAME, MAX_DEVICE_NAME };