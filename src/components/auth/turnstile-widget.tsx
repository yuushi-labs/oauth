'use client';

import * as React from 'react';

/**
 * Cloudflare Turnstile のウィジェット（Phase 9 / BUG-22）。
 *
 * サーバ側の `TurnstileCaptchaProvider`（siteverify）だけでは CAPTCHA は機能しない。
 * ブラウザが site key でウィジェットを描画し、得た token をフォームが送る必要がある。
 *
 * - `siteKey` は**サーバコンポーネントが解決して props で渡す**（`process.env` を
 *   クライアントで読むと hydration mismatch になる・BUG-11）。
 * - script は CSP の nonce を付けて 1 回だけ注入する（`strict-dynamic` により
 *   以降の動的ロードも信頼される）。
 * - `active` が false の間は何も描画しない（＝CAPTCHA 不要な通常時は負荷ゼロ）。
 */

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      'timeout-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
      action?: string;
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(nonce?: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Turnstile script failed')));
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    // strict-dynamic + nonce: the injected script inherits the document's trust.
    if (nonce) script.nonce = nonce;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Turnstile script failed')));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  nonce,
  action,
  resetKey = 0,
}: {
  siteKey: string;
  /** token を得たら呼ぶ。失効・エラー時は null。 */
  onToken: (token: string | null) => void;
  /** インライン script と同じ CSP nonce（middleware が発行）。 */
  nonce?: string;
  action?: string;
  /**
   * この値が変わるとウィジェットを `reset` して新しい token を取り直す。
   * Turnstile の token は**1 回限り**なので、送信が失敗して token が消費された後に
   * 再送信するにはリセットが必要（さもないと常に `CAPTCHA_INVALID` になる）。
   */
  resetKey?: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const onTokenRef = React.useRef(onToken);
  onTokenRef.current = onToken;
  const prevResetKeyRef = React.useRef(resetKey);

  React.useEffect(() => {
    let cancelled = false;
    loadTurnstileScript(nonce)
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetIdRef.current !== null) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          'error-callback': () => onTokenRef.current(null),
          'expired-callback': () => onTokenRef.current(null),
          'timeout-callback': () => onTokenRef.current(null),
          theme: 'auto',
          ...(action ? { action } : {}),
        });
      })
      .catch(() => onTokenRef.current(null));

    return () => {
      cancelled = true;
      const id = widgetIdRef.current;
      widgetIdRef.current = null;
      if (id !== null && window.turnstile) {
        try {
          window.turnstile.remove(id);
        } catch {
          /* the widget may already be gone */
        }
      }
    };
  }, [siteKey, nonce, action]);

  React.useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    const id = widgetIdRef.current;
    if (id !== null && window.turnstile) {
      try {
        window.turnstile.reset(id);
      } catch {
        /* the widget may already be gone */
      }
    }
  }, [resetKey]);

  return <div ref={containerRef} data-testid="turnstile-widget" />;
}
