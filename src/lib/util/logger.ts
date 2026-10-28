import { getRequestId } from '@/lib/util/request-context';

export const REDACTED = '***';

const MAX_DEPTH = 6;

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secret',
  'totpsecret',
  'secretciphertext',
  'secretencrypted',
  'otpauthuri',
  'recoverycode',
  'recoverycodes',
  'qrsvg',
  'sessiontoken',
  'sessionhash',
  'csrftoken',
  'authorization',
  'cookie',
  'apikey',
  'pepper',
  'sessionpepper',
  'tokenpepper',
  'iphashpepper',
  'encryptionkey',
  'privatekey',
  'code',
  'state',
  'nonce',
  'codeverifier',
  // Passkey / WebAuthn（D-34-14）。challenge は使い捨ての乱数でログに残す理由が無い。
  'credentialid',
  'publickey',
  'attestationobject',
  'authenticatordata',
  'clientdatajson',
  'signature',
  'challenge',
]);

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /(token|code_verifier|code|state|nonce|password|secret|pepper|api_key|apikey)=([^&\s"'`<>]+)/gi,
  // argon2 ハッシュは資格情報そのもの。Drizzle の失敗クエリはバインド値を message へ
  // 展開するため、エラーを丸ごとログへ流すと保存済みハッシュが平文で残る。
  // ハッシュはパラメータ部にカンマを含むので、空白までを 1 トークンとして丸ごと伏せる。
  /\$argon2[a-z0-9]*\$[^\s'"`<>]+/gi,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function redactText(text: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (acc, pattern) =>
      acc.replace(pattern, (_match: string, key?: string) =>
        typeof key === 'string' ? `${key}=${REDACTED}` : REDACTED,
      ),
    text,
  );
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return result;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMeta = Record<string, unknown>;

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  const requestId = getRequestId();
  const payload = {
    level,
    time: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
    message: redactText(message),
    ...(meta ? (redact(meta) as LogMeta) : {}),
  };
  const line = JSON.stringify(payload);

  switch (level) {
    case 'error':
      console.error(line);
      return;
    case 'warn':
      console.warn(line);
      return;
    default:
      console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: LogMeta) => write('debug', message, meta),
  info: (message: string, meta?: LogMeta) => write('info', message, meta),
  warn: (message: string, meta?: LogMeta) => write('warn', message, meta),
  error: (message: string, meta?: LogMeta) => write('error', message, meta),
};