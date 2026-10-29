/**
 * authorize URL から state を抜き出すテストヘルパ。
 * 認可フローのテストは「start → callback」を往復させるので、
 * state の受け渡しを毎回手で書く必要がないようにしておく。
 */
export function extractCallbackState(location: string): string | null {
  try {
    return new URL(location).searchParams.get('state');
  } catch {
    return null;
  }
}

/** authorize URL が期待する provider の認可エンドポイントにあるか。 */
export function authorizeOrigin(location: string): string {
  const url = new URL(location);
  return `${url.origin}${url.pathname}`;
}