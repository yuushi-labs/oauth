/**
 * Drizzle は失敗したクエリを `Failed query: ...` でラップし、真の原因（接続失敗・認証失敗など）を
 * `error.cause` に隠す。CLI スクリプトがこれをそのまま出すと、BUG-21 と同じく
 * 「DB に繋がっていない」ことが分からないまま「クエリが失敗した」とだけ見える。
 *
 * `cause` を辿って 1 つの文字列にまとめる。深さは無限ループを避けるため上限を設ける。
 */
export function describeErrorChain(error: unknown, maxDepth = 5): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    lines.push(depth === 0 ? message : `caused by: ${message}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join('\n');
}
