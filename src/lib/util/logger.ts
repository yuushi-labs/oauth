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
  'recoverycode',
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
]);

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /(token|code_verifier|password|secret|pepper|api_key|apikey)=([^&\s"'`<>]+)/gi,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function redactText(text: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, (_match, key: string) => `${key}=${REDACTED}`),
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
  const payload = {
    level,
    time: new Date().toISOString(),
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