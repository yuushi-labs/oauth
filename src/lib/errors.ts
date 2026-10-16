export const ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'EMAIL_TAKEN',
  'RATE_LIMITED',
  'REAUTH_REQUIRED',
  'INVALID_TOKEN',
  'SESSION_EXPIRED',
  'ACCOUNT_SUSPENDED',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'CSRF_FAILED',
  'INVALID_PROVIDER',
  'INVALID_STATE',
  'INVALID_CODE',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_INVALID',
  'CAPTCHA_UNCONFIGURED',
  'CAPTCHA_PROVIDER_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
  RATE_LIMITED: 429,
  REAUTH_REQUIRED: 401,
  INVALID_TOKEN: 400,
  SESSION_EXPIRED: 401,
  ACCOUNT_SUSPENDED: 403,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
  CSRF_FAILED: 403,
  INVALID_PROVIDER: 404,
  INVALID_STATE: 400,
  INVALID_CODE: 401,
  CAPTCHA_REQUIRED: 400,
  CAPTCHA_INVALID: 400,
  CAPTCHA_UNCONFIGURED: 500,
  CAPTCHA_PROVIDER_ERROR: 503,
};

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_CREDENTIALS: '認証情報が正しくありません。',
  EMAIL_TAKEN: 'このメールアドレスは使用できません。',
  RATE_LIMITED: 'リクエストが多すぎます。しばらくしてからお試しください。',
  REAUTH_REQUIRED: '本人確認が必要です。',
  INVALID_TOKEN: 'リンクが無効か、有効期限が切れています。',
  SESSION_EXPIRED: 'セッションの有効期限が切れました。',
  ACCOUNT_SUSPENDED: 'このアカウントは利用できません。',
  VALIDATION_ERROR: '入力内容を確認してください。',
  INTERNAL_ERROR: 'エラーが発生しました。',
  CSRF_FAILED: 'リクエストを検証できませんでした。',
  INVALID_PROVIDER: '指定された認証プロバイダーは利用できません。',
  INVALID_STATE: '認証リクエストを検証できませんでした。もう一度お試しください。',
  INVALID_CODE: '認証コードが正しくありません。',
  CAPTCHA_REQUIRED: '追加の確認が必要です。',
  CAPTCHA_INVALID: '確認に失敗しました。もう一度お試しください。',
  CAPTCHA_UNCONFIGURED: '追加確認の設定が完了していません。',
  CAPTCHA_PROVIDER_ERROR: '追加確認サービスを利用できません。',
};

export function defaultMessage(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

export type ApiErrorBody = {
  success: false;
  error: { code: ErrorCode; message: string };
};

export type ApiSuccessBody<T> = {
  success: true;
  data: T;
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, status?: number) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
  }
}

export function ok<T>(data: T): ApiSuccessBody<T> {
  return { success: true, data };
}

export function fail(code: ErrorCode, message?: string): ApiErrorBody {
  return { success: false, error: { code, message: message ?? DEFAULT_MESSAGES[code] } };
}

export type NormalizedError = { status: number; body: ApiErrorBody };

/** 未知の例外をクライアントへ返さない形に正規化する（仕様45章・58章）。 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof ApiError) {
    return { status: error.status, body: fail(error.code, error.message) };
  }
  return { status: ERROR_STATUS.INTERNAL_ERROR, body: fail('INTERNAL_ERROR') };
}
