import { redactText } from '@/lib/util/logger';

/**
 * ログの secret 検知（Phase 9 / D-39-06）。
 *
 * 稼働ログに認証トークンが残っていないかを走査する。検出結果には**値ではなく行番号**だけを
 * 返す（検知器自体を漏洩源にしない・§45）。パターンは `logger.ts` の redaction を再利用し、
 * 二重管理を避ける。
 *
 * 既定で検出するのは **URL に載る認証トークン**（`token` / `code` / `state` / `nonce` /
 * `code_verifier`）。`password` / `secret` / `pepper` / `api_key` は正当な機密だが、設定例や
 * フォーム項目名の出力でも一致しやすい。日次実行の走査がノイズで無視されないよう、
 * これらは `includeCredentialKeys` を明示したときだけ検出する（D-39-06）。
 */

export type SecretFinding = {
  line: number;
  /** 検出した種別（`token` / `code` / `state` / `nonce` / `code_verifier` 等）。 */
  key: string;
};

/** 常時検出する認証トークン（URL に載る値・§17.2.1）。 */
const AUTH_TOKEN_KEYS = ['token', 'code_verifier', 'code', 'state', 'nonce'] as const;

/** ノイズになりやすい資格情報キー（`includeCredentialKeys` で有効化）。 */
const CREDENTIAL_KEYS = ['password', 'secret', 'pepper', 'api_key', 'apikey'] as const;

export type ScanOptions = {
  /** `password` / `secret` 等の資格情報キーも検出対象にする（既定 false）。 */
  includeCredentialKeys?: boolean;
};

function buildPattern(options: ScanOptions | undefined): RegExp {
  const keys = options?.includeCredentialKeys
    ? [...AUTH_TOKEN_KEYS, ...CREDENTIAL_KEYS]
    : [...AUTH_TOKEN_KEYS];
  return new RegExp(`(${keys.join('|')})=([^&\\s"'\`<>]+)`, 'gi');
}

/**
 * 1 行を走査する。secret の key=value を検出したら**値は捨て**、種別だけを返す。
 * `redactText` を通して変化が無ければ「漏洩していない」とみなす。
 */
export function scanLine(line: string, lineNumber: number, options?: ScanOptions): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const match of line.matchAll(buildPattern(options))) {
    const key = match[1];
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    findings.push({ line: lineNumber, key: normalized });
  }
  return findings;
}

/** テキスト全体を走査し、secret を含む行を報告する（値は含めない）。 */
export function scanForSecrets(text: string, options?: ScanOptions): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    findings.push(...scanLine(lines[index] ?? '', index + 1, options));
  }
  return findings;
}

/** redaction が有効か（`redactText` が値を伏せるか）を確認する。テスト・自己診断用。 */
export function isRedacted(text: string): boolean {
  return redactText(text) !== text;
}
