import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha1Hex(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** 長さが違う場合は比較時間を揃えるためダミー比較を行う（§25 CSRF トークン検証用）。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function generatePepper(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function generateTotpEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}