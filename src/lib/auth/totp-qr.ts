import QRCode from 'qrcode';
import { ApiError } from '@/lib/errors';

/**
 * `otpauth://` URI を SVG 文字列にする。外部通信なし（secret を第三者に送らない・§45）。
 * `qrcode` の薄いラッパ（D-33-02）。QR 仕様の正しさはパッケージに委ねる。
 */
export async function otpauthUriToSvg(
  uri: string,
  options: { size?: number; margin?: number } = {},
): Promise<string> {
  try {
    return await QRCode.toString(uri, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: options.margin ?? 2,
      width: options.size ?? 240,
    });
  } catch {
    throw new ApiError('INTERNAL_ERROR', 'QR コードの生成に失敗しました');
  }
}
