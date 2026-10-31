/**
 * Drizzle は失敗したクエリを `Failed query: ...` でラップし、真の原因（接続失敗・認証失敗など）を
 * `error.cause` に隠す。CLI スクリプトがこれをそのまま出すと、BUG-21 と同じく
 * 「DB に繋がっていない」ことが分からないまま「クエリが失敗した」とだけ見える。
 *
 * `cause` を辿って 1 つの文字列にまとめる。深さは無限ループを避けるため上限を設ける。
 * 走査は**深さだけ**で止める（`current` の truthiness で止めない）。`cause` に falsy な
 * 拒否理由（`''` / `0` / `false`）が入っていても取りこぼさないため。`cause` を持たない値に
 * 達したら終了する。
 */
export function describeErrorChain(error: unknown, maxDepth = 5): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (current instanceof Error) {
      lines.push(depth === 0 ? current.message : `caused by: ${current.message}`);
      if (current.cause === undefined) break;
      current = current.cause;
      continue;
    }
    // Error でない値（throw された文字列・オブジェクトなど）も 1 行として残す。
    lines.push(depth === 0 ? String(current) : `caused by: ${String(current)}`);
    break;
  }
  return lines.join('\n');
}
