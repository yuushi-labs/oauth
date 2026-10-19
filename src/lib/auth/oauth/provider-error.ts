/** provider との通信で起きた障害を分類するための内部エラー。message は外部に出さない。 */
export class ProviderError extends Error {
  constructor(
    readonly reason:
      | 'token_exchange_failed'
      | 'id_token_invalid'
      | 'nonce_mismatch'
      | 'userinfo_failed'
      | 'no_access_token',
  ) {
    super(reason);
    this.name = 'ProviderError';
  }
}