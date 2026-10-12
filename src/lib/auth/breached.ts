import { sha1Hex } from '@/lib/util/crypto';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/util/logger';

const HIBP_API = 'https://api.pwnedpasswords.com/range';

export type BreachCheckResult = {
  breached: boolean;
  failOpen: boolean;
};

/**
 * HIBP でパスワードが漏洩しているか確認する（fail-open）。
 * - timeout / HTTP error 時は BREACH_CHECK_FAIL_OPEN に従う。
 * - fail-open 時は security_events に breach_check_fail_open イベントを記録する（呼び出し元で処理）。
 */
export async function checkBreached(password: string): Promise<BreachCheckResult> {
  const env = getEnv();
  const hash = sha1Hex(password).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.HIBP_TIMEOUT_MS);

  try {
    const response = await fetch(`${HIBP_API}/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HIBP API error: ${response.status}`);
    }

    const text = await response.text();
    const matches = text.split('\n').map((line) => line.trim().toUpperCase());
    const found = matches.some((line) => line.startsWith(suffix));

    return { breached: found, failOpen: false };
  } catch (error) {
    logger.warn('HIBP breach check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { breached: false, failOpen: env.BREACH_CHECK_FAIL_OPEN };
  } finally {
    clearTimeout(timeout);
  }
}