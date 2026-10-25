import { TOTP, Secret } from 'otpauth';
import { encryptTotpSecret, decryptTotpSecret } from '@/lib/auth/totp-crypto';
import { consumeTotpCounter, findTotpByUserId } from '@/lib/db/queries/totp';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;

/** 20 バイト（160 bit）の base32 secret を生成し、保存用に暗号化した値も返す。 */
export function generateTotpSecret(): { base32: string; encrypted: string } {
  const secret = new Secret({ size: 20 });
  return { base32: secret.base32, encrypted: encryptTotpSecret(secret.base32) };
}

/** `otpauth://totp/<issuer>:<label>?secret=...&issuer=<issuer>&algorithm=SHA1&digits=6&period=30` */
export function buildOtpauthUri(args: { issuer: string; label: string; secretBase32: string }): string {
  return new TOTP({
    issuer: args.issuer,
    label: args.label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(args.secretBase32),
  }).toString();
}

/**
 * コードを検証し、成功したら「一致した counter」を atomic に消費する（D-33-04 / D-33-05）。
 *
 * 消費は `last_used_counter < c` の単文 UPDATE の更新行数で判定する。read → 判定 → write の
 * 2 段書きをしないため、同一コードの並行送信でも成功するのは 1 リクエストだけになる（T3）。
 */
export async function verifyAndConsumeTotp(args: {
  userId: string;
  code: string;
  now?: Date;
  /**
   * 有効化フロー（setup → verify）は `enabled = true` になる前にコードを検証するため true を渡す。
   * 保留行（enabled=false）でも検証・消費を許可する。既定 false（通常の検証は有効行のみ）。
   */
  allowPending?: boolean;
}): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'replayed' }> {
  const row = await findTotpByUserId(args.userId);
  if (!row) return { ok: false, reason: 'invalid' };
  if (!row.enabled && !args.allowPending) return { ok: false, reason: 'invalid' };

  let secretBase32: string;
  try {
    secretBase32 = decryptTotpSecret(row.secretEncrypted);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const timestamp = (args.now ?? new Date()).getTime();
  const delta = TOTP.validate({
    token: args.code,
    secret: Secret.fromBase32(secretBase32),
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    window: TOTP_WINDOW,
    timestamp,
  });
  if (delta === null) return { ok: false, reason: 'invalid' };

  // delta は「一致した counter が基準 counter からどれだけずれたか」。基準 + delta が実際に一致した counter。
  const matchedCounter = TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp }) + delta;
  const consumed = await consumeTotpCounter(args.userId, matchedCounter, {
    requireEnabled: !args.allowPending,
  });
  return consumed ? { ok: true } : { ok: false, reason: 'replayed' };
}
