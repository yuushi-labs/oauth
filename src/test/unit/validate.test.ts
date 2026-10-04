import { describe, expect, it } from 'vitest';
import { emailSchema } from '@/lib/validate/email';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
} from '@/lib/validate/password';
import { USERNAME_MAX_LENGTH, usernameSchema } from '@/lib/validate/username';

describe('emailSchema', () => {
  it('小文字正規化して通す', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com');
  });

  it('形式不正は拒否する', () => {
    for (const value of ['not-an-email', 'a@b', '@example.com', 'user@']) {
      expect(emailSchema.safeParse(value).success).toBe(false);
    }
  });

  it('254文字を超える場合は拒否する', () => {
    const tooLong = `${'a'.repeat(250)}@example.com`;
    expect(emailSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('usernameSchema', () => {
  it('英数字・ハイフン・アンダースコアを許可する', () => {
    expect(usernameSchema.parse('yuushi_01')).toBe('yuushi_01');
    expect(usernameSchema.parse('Yu-shi')).toBe('Yu-shi');
  });

  it('長さ境界（3〜32）を守る', () => {
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('abc').success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('使用できない文字を拒否する', () => {
    expect(usernameSchema.safeParse('user name').success).toBe(false);
    expect(usernameSchema.safeParse('user@example').success).toBe(false);
    expect(usernameSchema.safeParse('ユーザー').success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it(`${PASSWORD_MIN_LENGTH}文字未満を拒否する（C-02）`, () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
  });

  it(`${PASSWORD_MAX_LENGTH}文字超を拒否する（長すぎるパスワードは許可しない）`, () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('Unicode とスペースを許可する（ASCII 限定・スペース禁止にしない）', () => {
    expect(passwordSchema.safeParse('パスワード です').success).toBe(true);
    expect(passwordSchema.safeParse('pass word 123').success).toBe(true);
    expect(passwordSchema.safeParse('🔐🔐🔐🔐🔐🔐🔐🔐').success).toBe(true);
  });

  it('空白のみは拒否する', () => {
    expect(passwordSchema.safeParse('        ').success).toBe(false);
  });
});