import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from '@/lib/env';

/**
 * TOTP secret の保存時暗号化（§13.1「DB 保存時に暗号化、鍵は DB に保存しない」）。
 * 鍵は環境変数 `TOTP_ENCRYPTION_KEY`（Base64 32 バイト）で、DB には置かない。
 * OIDC の暗号鍵とは分離する（D-33-03）。
 */
function key(): Buffer {
  const value = getEnv().TOTP_ENCRYPTION_KEY;
  if (!value) throw new Error('TOTP_ENCRYPTION_KEY is required');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes of base64');
  return decoded;
}

/** `v1.<nonce>.<tag>.<ciphertext>`（各 base64url）。形式は `oidc/crypto.ts` とそろえる。 */
export function encryptTotpSecret(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** 改竄（tag 不一致）・形式不正は throw する。呼び出し側で INTERNAL_ERROR に丸める。 */
export function decryptTotpSecret(payload: string): string {
  const [version, nonce, tag, ciphertext] = payload.split('.');
  if (version !== 'v1' || !nonce || !tag || !ciphertext) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
