import { describe, expect, it } from 'vitest';
import {
  ClientValidationError,
  isRegisteredRedirectUri,
  redirectUriAllowedForLoopback,
  validateRedirectUri,
} from '@/lib/oidc/client-validation';
import { normalizeRedirectTo, safeRedirectPath, isSafeRedirectPath } from '@/lib/auth/oauth/state';
import { redirectUriFor } from '@/lib/auth/oauth/redirect-uri';

/**
 * §48「OAuth redirect」カテゴリの正規テスト（D-38-05）。
 *
 * OIDC クライアント登録時の `redirect_uri` は **完全一致の https のみ**。
 * loopback だけが http を許される（本番は不可）。加えて、ログイン後の戻り先
 * （`redirect_to`）と provider 用の callback URL 導出が安全であることを固定する。
 */
describe('Security - OIDC redirect_uri registration (§48 / §12)', () => {
  it('https の完全一致 URI を受理する', () => {
    expect(validateRedirectUri('https://app.example.com/callback')).toBe('https://app.example.com/callback');
  });

  it('非 loopback の http は拒否する', () => {
    expect(() => validateRedirectUri('http://app.example.com/callback')).toThrow(ClientValidationError);
  });

  it('loopback の http は dev では許可する', () => {
    // setup.ts は NODE_ENV=test。loopback http は許される。
    expect(validateRedirectUri('http://localhost:3000/callback')).toBe('http://localhost:3000/callback');
    expect(redirectUriAllowedForLoopback('http://127.0.0.1:8080/cb')).toBe(true);
  });

  it('ユーザ情報・fragment・非 http(s) scheme を拒否する（open redirect / 情報漏洩対策）', () => {
    expect(() => validateRedirectUri('https://user:pass@app.example.com/cb')).toThrow();
    expect(() => validateRedirectUri('https://app.example.com/cb#frag')).toThrow();
    expect(() => validateRedirectUri('javascript:alert(1)')).toThrow();
    expect(() => validateRedirectUri('not a url')).toThrow();
  });

  it('未登録の redirect_uri は exact-match で拒否する', () => {
    const registered = ['https://app.example.com/callback'];
    expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback')).toBe(true);
    // 前方一致・サブドメイン追加・クエリ追加はすべて未登録扱い（open redirect 防止）
    expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback/extra')).toBe(false);
    expect(isRegisteredRedirectUri(registered, 'https://evil.example.com/callback')).toBe(false);
    expect(isRegisteredRedirectUri(registered, 'https://app.example.com/callback?x=1')).toBe(false);
    expect(isRegisteredRedirectUri(registered, 'https://app.example.com.evil.com/callback')).toBe(false);
  });

  it('provider callback の redirect_uri は設定値から導出し、Host を使わない（D-31-01）', () => {
    expect(redirectUriFor('google')).toBe('http://localhost:3000/api/auth/oauth/google/callback');
    expect(redirectUriFor('github')).toBe('http://localhost:3000/api/auth/oauth/github/callback');
    expect(redirectUriFor('discord')).not.toContain('evil.example');
  });
});

describe('Security - redirect_to normalization (open redirect §48)', () => {
  it('同一オリジンの相対パスだけを許可する', () => {
    expect(normalizeRedirectTo('/settings/sessions')).toBe('/settings/sessions');
  });

  it('絶対 URL・プロトコル相対・バックスラッシュ細工を拒否する', () => {
    expect(normalizeRedirectTo('https://evil.example/')).toBeNull();
    expect(normalizeRedirectTo('//evil.example/')).toBeNull();
    expect(normalizeRedirectTo('/\\evil.example')).toBeNull();
    expect(normalizeRedirectTo('settings')).toBeNull();
    expect(normalizeRedirectTo('')).toBeNull();
    expect(normalizeRedirectTo(null)).toBeNull();
  });
});

/**
 * Aikido Issue #2: リダイレクト直前の最終防衛線。
 *
 * 戻り先は DB を経由するため、保存時の正規化だけに依存せず、`NextResponse.redirect` へ
 * 渡す直前にも同じ判定を通す（`safeRedirectPath`）。ここではその振る舞いを固定する。
 */
describe('Security - safeRedirectPath (redirect sink guard / Issue #2)', () => {
  it('同一オリジンの相対パスはそのまま返す', () => {
    expect(safeRedirectPath('/settings/sessions')).toBe('/settings/sessions');
    // クエリ付きの既存の戻り先も壊さない
    expect(safeRedirectPath('/login?error=cancelled')).toBe('/login?error=cancelled');
    expect(isSafeRedirectPath('/settings/sessions')).toBe(true);
  });

  it('外部オリジンへ飛ぶ値は fallback の / に落とす', () => {
    for (const value of [
      'https://evil.example/steal',
      'http://evil.example',
      '//evil.example/steal',
      '/\\evil.example/steal',
      'javascript:alert(1)',
      'https:evil.example',
      'settings',
      ' /settings',
      '',
      null,
      undefined,
    ]) {
      expect(safeRedirectPath(value)).toBe('/');
      expect(isSafeRedirectPath(value)).toBe(false);
    }
  });

  it('制御文字（改行・NUL・DEL）を含む値は拒否する', () => {
    for (const value of ['/a\u0000b', '/a\nb', '/a\rb', '/a\u007fb', '/a\tb']) {
      expect(safeRedirectPath(value)).toBe('/');
    }
  });

  it('fallback を指定すればそちらに落ちる', () => {
    expect(safeRedirectPath('https://evil.example/', '/login')).toBe('/login');
    expect(safeRedirectPath(undefined, '/settings')).toBe('/settings');
  });

  it('長すぎる値は 200 文字に切りつめ、相対パスのまま保つ', () => {
    const normalized = safeRedirectPath(`/${'a'.repeat(300)}`);
    expect(normalized).toHaveLength(200);
    expect(normalized.startsWith('/')).toBe(true);
  });
});
