import { randomToken, sha256Hex } from '@/lib/util/crypto';
import { newId } from '@/lib/util/id';

export function generateToken(): { raw: string; hash: string; id: string } {
  const raw = randomToken(32);
  const hash = sha256Hex(raw);
  const id = newId('tok');
  return { raw, hash, id };
}

export function hashToken(raw: string): string {
  return sha256Hex(raw);
}