import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ERROR_CODES,
  ERROR_STATUS,
  defaultMessage,
  fail,
  normalizeError,
  ok,
} from '@/lib/errors';

describe('ok / fail', () => {
  it('成功は §58 の形に一致する', () => {
    expect(ok({ id: 'usr_1' })).toEqual({ success: true, data: { id: 'usr_1' } });
  });

  it('エラーは §58 の形に一致する', () => {
    expect(fail('INVALID_CREDENTIALS')).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: '認証情報が正しくありません。' },
    });
  });

  it('既定メッセージは日本語・ユーザー列挙にhelpful な文言を含まない', () => {
    for (const code of ERROR_CODES) {
      const message = defaultMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain('stack');
      expect(message).not.toContain('SELECT');
    }
    expect(defaultMessage('EMAIL_TAKEN')).not.toContain('登録されています');
  });
});

describe('ApiError', () => {
  it('code から HTTP status を決める', () => {
    expect(new ApiError('INVALID_CREDENTIALS').status).toBe(401);
    expect(new ApiError('RATE_LIMITED').status).toBe(429);
    expect(new ApiError('CSRF_FAILED').status).toBe(403);
    expect(new ApiError('INTERNAL_ERROR').status).toBe(500);
    expect(new ApiError('ACCOUNT_SUSPENDED').status).toBe(ERROR_STATUS.ACCOUNT_SUSPENDED);
  });
});

describe('normalizeError', () => {
  it('未知の例外は詳細を伏せて INTERNAL_ERROR にする（仕様45）', () => {
    const error = new Error('connection to postgres://user:secret@db failed');
    const normalized = normalizeError(error);

    expect(normalized.status).toBe(500);
    expect(normalized.body.success).toBe(false);
    expect(JSON.stringify(normalized.body)).not.toContain('secret');
    expect(normalized.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('ApiError は code とメッセージを保持する', () => {
    const normalized = normalizeError(new ApiError('REAUTH_REQUIRED'));
    expect(normalized.status).toBe(401);
    expect(normalized.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('文字列や null の例外でも落ちない', () => {
    expect(normalizeError('boom').body.error.code).toBe('INTERNAL_ERROR');
    expect(normalizeError(null).body.error.code).toBe('INTERNAL_ERROR');
    expect(normalizeError(undefined).status).toBe(500);
  });
});