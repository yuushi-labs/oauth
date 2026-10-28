import { Secret, TOTP } from 'otpauth';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '@/lib/auth/totp';

/**
 * TOTP コード生成のテストヘルパ（D-38-06）。
 *
 * テストごとに `new TOTP({...})` を組み立てる重複をなくす。`at` を渡せば
 * `vi.useFakeTimers()` で固定した時刻に一致するコードを作れる。
 */
export function totpCodeFor(secretBase32: string, at: Date = new Date()): string {
  return new TOTP({
    secret: Secret.fromBase32(secretBase32),
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).generate({ timestamp: at.getTime() });
}

/** 現在のカウンター（`floor(unixSeconds / period)`）。消費の検証に使う。 */
export function totpCounterAt(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}
