import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';

export const CLIENT_SECRET_HASH_PREFIX = 'hmac-sha256:';

function key(): Buffer {
  const value = getEnv().OIDC_ADAPTER_ENCRYPTION_KEY;
  if (!value) throw new Error('OIDC_ADAPTER_ENCRYPTION_KEY is required when OIDC is enabled');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error('OIDC_ADAPTER_ENCRYPTION_KEY must be 32 bytes of base64');
  return decoded;
}

export function oidcIdHash(id: string): string {
  const lookupKey = createHmac('sha256', key()).update('oidc-provider-id-lookup-v1').digest();
  return createHmac('sha256', lookupKey).update(id).digest('hex');
}

export function encryptOidcValue(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptOidcValue(value: string): string {
  const [version, nonce, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !nonce || !tag || !ciphertext) throw new Error('Invalid encrypted OIDC value');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function clientSecretDigest(secret: string): string {
  return createHmac('sha256', getEnv().TOKEN_PEPPER)
    .update(`oidc-client-secret-v1\0${secret}`)
    .digest('base64url');
}

export function hashClientSecret(secret: string): string {
  return `${CLIENT_SECRET_HASH_PREFIX}${clientSecretDigest(secret)}`;
}

export function verifyClientSecretHash(stored: string, provided: string): boolean {
  if (!stored.startsWith(CLIENT_SECRET_HASH_PREFIX)) return false;
  const expected = Buffer.from(stored.slice(CLIENT_SECRET_HASH_PREFIX.length), 'base64url');
  const actual = Buffer.from(clientSecretDigest(provided), 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isClientSecretHash(value: string): boolean {
  return value.startsWith(CLIENT_SECRET_HASH_PREFIX) && value.length > CLIENT_SECRET_HASH_PREFIX.length;
}
