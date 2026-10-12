import { hash, verify, parseOptions } from '@node-rs/argon2';
import { getEnv } from '@/lib/env';

const DEFAULTS = { m: 19456, t: 2, p: 1 } as const;
const ARGON2ID = 2; // Algorithm.Argon2id

function getOptions() {
  const env = getEnv();
  return {
    memoryCost: env.ARGON2_M ?? DEFAULTS.m,
    timeCost: env.ARGON2_T ?? DEFAULTS.t,
    parallelism: env.ARGON2_P ?? DEFAULTS.p,
    algorithm: ARGON2ID,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, getOptions());
}

export async function verifyPassword(password: string, hashStr: string): Promise<boolean> {
  try {
    return await verify(hashStr, password);
  } catch {
    return false;
  }
}

/**
 * パラメータ変更検知: ハッシュの m/t/p が現在の設定と異なれば true
 */
export function needsRehash(hashStr: string): boolean {
  try {
    const params = parseOptions(hashStr);
    const env = getEnv();
    return (
      params.memoryCost !== (env.ARGON2_M ?? DEFAULTS.m) ||
      params.timeCost !== (env.ARGON2_T ?? DEFAULTS.t) ||
      params.parallelism !== (env.ARGON2_P ?? DEFAULTS.p)
    );
  } catch {
    return true;
  }
}

export function isArgon2Hash(hashStr: string): boolean {
  return hashStr.startsWith('$argon2');
}