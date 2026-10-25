import { beforeEach, describe, expect, it, vi } from 'vitest';

const toString = vi.hoisted(() => vi.fn());

vi.mock('qrcode', () => ({
  default: { toString },
}));

import { otpauthUriToSvg } from '@/lib/auth/totp-qr';
import { ApiError } from '@/lib/errors';

const URI = 'otpauth://totp/oauth:alice?issuer=oauth&secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('otpauthUriToSvg', () => {
  it('<svg を含む文字列を返す', async () => {
    toString.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const svg = await otpauthUriToSvg(URI);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('qrcode に渡す引数が正しい（type: svg / errorCorrectionLevel: M）', async () => {
    toString.mockResolvedValue('<svg/>');
    await otpauthUriToSvg(URI);
    expect(toString).toHaveBeenCalledWith(URI, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    });
  });

  it('size / margin を上書きできる', async () => {
    toString.mockResolvedValue('<svg/>');
    await otpauthUriToSvg(URI, { size: 320, margin: 4 });
    expect(toString).toHaveBeenCalledWith(URI, expect.objectContaining({ width: 320, margin: 4 }));
  });

  it('同じ URI で決定的（同じ入力 → 同じ出力）', async () => {
    toString.mockResolvedValue('<svg>deterministic</svg>');
    expect(await otpauthUriToSvg(URI)).toBe(await otpauthUriToSvg(URI));
  });

  it('qrcode が throw したら INTERNAL_ERROR に丸める', async () => {
    toString.mockRejectedValue(new Error('qrcode failed'));
    await expect(otpauthUriToSvg(URI)).rejects.toBeInstanceOf(ApiError);
    await expect(otpauthUriToSvg(URI)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('外部通信をしない（fetch を呼ばない）', async () => {
    toString.mockResolvedValue('<svg/>');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await otpauthUriToSvg(URI);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
