import { ApiError } from '@/lib/errors';

export interface CaptchaProvider {
  verify(token: string | null, remoteIp?: string): Promise<boolean>;
}

/** Local/test placeholder. It is never allowed to bypass a production challenge. */
export class NoopCaptchaProvider implements CaptchaProvider {
  async verify(): Promise<boolean> {
    return true;
  }
}

const noopProvider = new NoopCaptchaProvider();

export async function verifyCaptchaIfRequired(
  required: boolean,
  token: string | null,
  remoteIp?: string,
): Promise<void> {
  if (!required) return;
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.TURNSTILE_SECRET_KEY) throw new ApiError('CAPTCHA_UNCONFIGURED');
    // Phase 9 wires the real Turnstile verifier. Never treat a configured key as verified.
    throw new ApiError('CAPTCHA_PROVIDER_ERROR');
  }
  const provider: CaptchaProvider = noopProvider;
  if (!await provider.verify(token, remoteIp)) throw new ApiError('CAPTCHA_INVALID');
}
