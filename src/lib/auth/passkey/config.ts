/**
 * WebAuthn（Passkey）の `rpID` / `rpName` / 許可 origin を **環境ごとの明示設定**として解決する
 * （D-34-01 / D-26）。
 *
 * この module は **request / headers を受け取らない**。`Origin` / `Host` ヘッダから `rpID` や
 * origin を導出すると、Host ヘッダ偽装で検証を迂回できてしまう（§48「origin mismatch」）。
 * 解決した設定は `@simplewebauthn/server` の `expectedOrigin` / `expectedRPID` に渡し、
 * 許可リスト方式で照合させる。
 */
import { getEnv } from '@/lib/env';

export type WebauthnConfig = {
  /** WebAuthn の Relying Party ID（ポートを含めない登録可能ドメイン・例: 'example.com'）。 */
  rpID: string;
  /** 画面に出す RP 名（例: アプリ名）。 */
  rpName: string;
  /** 受け入れる origin の許可リスト（例: ['https://example.com']）。 */
  allowedOrigins: string[];
};

export type WebauthnEnvSource = {
  NODE_ENV?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ALLOWED_ORIGINS?: string;
};

const DEV_DEFAULT_RP_ID = 'localhost';
const DEV_DEFAULT_ORIGIN = 'http://localhost:3000';
const DEV_DEFAULT_RP_NAME = 'Auth System';

function isProduction(env: WebauthnEnvSource): boolean {
  return env.NODE_ENV === 'production';
}

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isValidOrigin(origin: string, production: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // origin はパス・クエリを持たない（scheme://host[:port] のみ）。
  if (url.pathname !== '/' || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  // dev/test のみ http://localhost を許容する。本番で http は許さない。
  if (!production && url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  }
  return false;
}

/** WebAuthn の rpID は origin の host と一致するか、その登録可能ドメインのサフィックスでなければならない。 */
function rpIdMatchesOrigin(rpID: string, origin: string): boolean {
  const host = new URL(origin).hostname;
  if (host === rpID) return true;
  // サブドメイン判定: host が `<label>.` + rpID で終わる（ラベル境界を守る）。
  return host.endsWith(`.${rpID}`);
}

function containsLocalhost(values: string[]): boolean {
  return values.some((value) => {
    try {
      const host = new URL(value).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
    } catch {
      return true;
    }
  });
}

/**
 * env から設定を解決する。**起動時 fail fast** のため、production で不整合があれば throw する。
 * `env` を引数で受けるのは、テストで `getEnv()` に依存せず検証できるようにするため。
 */
export function resolveWebauthnConfig(env: WebauthnEnvSource): WebauthnConfig {
  const production = isProduction(env);

  const rpID = env.WEBAUTHN_RP_ID?.trim() || (production ? '' : DEV_DEFAULT_RP_ID);
  const rpName = env.WEBAUTHN_RP_NAME?.trim() || DEV_DEFAULT_RP_NAME;
  const originsRaw = parseOrigins(env.WEBAUTHN_ALLOWED_ORIGINS);
  const allowedOrigins = originsRaw.length > 0 ? originsRaw : production ? [] : [DEV_DEFAULT_ORIGIN];

  if (!rpID) {
    throw new Error('WEBAUTHN_RP_ID が未設定です（production では必須です）');
  }
  if (allowedOrigins.length === 0) {
    throw new Error('WEBAUTHN_ALLOWED_ORIGINS が未設定です（production では必須です）');
  }

  if (production && rpID === 'localhost') {
    throw new Error('production で WEBAUTHN_RP_ID に localhost は使えません');
  }
  if (production && containsLocalhost(allowedOrigins)) {
    throw new Error('production で WEBAUTHN_ALLOWED_ORIGINS に localhost は使えません');
  }

  for (const origin of allowedOrigins) {
    if (!isValidOrigin(origin, production)) {
      throw new Error(`WEBAUTHN_ALLOWED_ORIGINS の要素が絶対 URL ではありません: ${origin}`);
    }
    if (!rpIdMatchesOrigin(rpID, origin)) {
      throw new Error(
        `WEBAUTHN_RP_ID (${rpID}) は origin (${origin}) の登録可能ドメインではありません`,
      );
    }
  }

  return { rpID, rpName, allowedOrigins };
}

/**
 * ログイン画面に Passkey ボタンを出すかの判定（§12.2）。
 *
 * 設定不備で**ログイン画面自体を壊さない**ため、解決に失敗したら `false` を返す（throw しない）。
 * 実際の認証時は `getWebauthnConfig()` が fail fast する。
 */
export function isPasskeyEnabled(): boolean {
  try {
    getWebauthnConfig();
    return true;
  } catch {
    return false;
  }
}

/** アプリの env から解決する。起動時に 1 度だけ呼ぶ想定（結果は呼び出し側でキャッシュしてよい）。 */
export function getWebauthnConfig(): WebauthnConfig {
  const env = getEnv();
  return resolveWebauthnConfig({
    NODE_ENV: env.NODE_ENV,
    WEBAUTHN_RP_ID: env.WEBAUTHN_RP_ID,
    WEBAUTHN_RP_NAME: env.WEBAUTHN_RP_NAME,
    WEBAUTHN_ALLOWED_ORIGINS: env.WEBAUTHN_ALLOWED_ORIGINS,
  });
}
