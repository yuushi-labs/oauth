import { ApiError } from '@/lib/errors';
import { logger } from '@/lib/util/logger';

export interface CaptchaProvider {
  verify(token: string | null, remoteIp?: string): Promise<boolean>;
}

/** Local/test placeholder. It is never allowed to bypass a production challenge. */
export class NoopCaptchaProvider implements CaptchaProvider {
  async verify(): Promise<boolean> {
    return true;
  }
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile の siteverify（P9-A-01 / D-39-01）。
 *
 * secret は **POST body** で送る（query に載せない）。応答の `error-codes` は
 * 設定ミスの情報を含むため、ログ・例外メッセージへ出さない（§45）。
 */
export class TurnstileCaptchaProvider implements CaptchaProvider {
  constructor(
    private readonly secret: string,
    private readonly timeoutMs = 3000,
  ) {}

  async verify(token: string | null, remoteIp?: string): Promise<boolean> {
    if (!token) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = new URLSearchParams({ secret: this.secret, response: token });
      if (remoteIp) body.set('remoteip', remoteIp);
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        logger.warn('CAPTCHA verification failed', { status: response.status });
        throw new ApiError('CAPTCHA_PROVIDER_ERROR');
      }
      const json = (await response.json()) as { success?: boolean };
      return json.success === true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.warn('CAPTCHA verification error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError('CAPTCHA_PROVIDER_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
}

const noopProvider = new NoopCaptchaProvider();
let providerOverride: CaptchaProvider | null = null;

/**
 * 差し替え口（D-39-01）。テストではネットワークを叩かない provider を注入する。
 * 本番では常に null のまま Turnstile が使われる。
 */
export function setCaptchaProvider(next: CaptchaProvider | null): void {
  providerOverride = next;
}

function captchaTimeoutMs(): number {
  const raw = Number(process.env.CAPTCHA_TIMEOUT_MS ?? '3000');
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

export async function verifyCaptchaIfRequired(
  required: boolean,
  token: string | null,
  remoteIp?: string,
): Promise<void> {
  if (!required) return;
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.TURNSTILE_SECRET_KEY) throw new ApiError('CAPTCHA_UNCONFIGURED');
    // No token means the client has not solved (or rendered) the widget yet. Tell it to
    // challenge, rather than reporting a bogus "invalid" — the old behaviour made the
    // soft-limit gate impossible to pass even with Turnstile configured (BUG-22).
    if (!token) throw new ApiError('CAPTCHA_REQUIRED');
    const provider: CaptchaProvider = providerOverride
      ?? new TurnstileCaptchaProvider(process.env.TURNSTILE_SECRET_KEY, captchaTimeoutMs());
    if (!await provider.verify(token, remoteIp)) throw new ApiError('CAPTCHA_INVALID');
    return;
  }
  const provider: CaptchaProvider = providerOverride ?? noopProvider;
  if (!await provider.verify(token, remoteIp)) throw new ApiError('CAPTCHA_INVALID');
}
