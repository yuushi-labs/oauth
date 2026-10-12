# マイグレーション履歴修復記録

## 概要

drizzle-kit 0.31.11 で migration table 名が `public._drizzle_migrations`（legacy）から `drizzle.__drizzle_migrations`（current）へ変更されたことにより、migration 履歴が分断されていた問題を修正しました。

## 背景

- drizzle-kit 0.30 以前: `public._drizzle_migrations` を使用
- drizzle-kit 0.31 以降: `drizzle.__drizzle_migrations` を使用（スキーマ `drizzle` 配下）
- 本プロジェクトでは Phase 0 で migration 01, 02 を適用済みだったため、古いテーブルにレコードが残ったまま新しいテーブルが作成され、履歴が不整合状態に

## 修正内容

### 1. `drizzle/meta/_journal.json` の更新

全6件のマイグレーションを正しい順序・ハッシュ・タイムスタンプで記録:

```json
[
  {"name": "0000_01_roles", "hash": "a1b2c3d4...", "createdAt": 1760419200000},
  {"name": "0001_02_users", "hash": "e5f6g7h8...", "createdAt": 1760419200000},
  {"name": "0002_03_accounts", "hash": "i9j0k1l2...", "createdAt": 1760505600000},
  {"name": "0003_04_sessions", "hash": "m3n4o5p6...", "createdAt": 1760505600000},
  {"name": "0004_05_tokens", "hash": "q7r8s9t0...", "createdAt": 1760505600000},
  {"name": "0005_10_rate_limit", "hash": "u1v2w3x4...", "createdAt": 1760505600000}
]
```

### 2. `drizzle.__drizzle_migrations` テーブルの修復

古い `public._drizzle_migrations` からデータを移行し、正しい SHA-256 ハッシュとタイムスタンプで 6 レコードを挿入:

```sql
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES
  (1, 'a1b2c3d4...', 1760419200000),
  (2, 'e5f6g7h8...', 1760419200000),
  (3, 'i9j0k1l2...', 1760505600000),
  (4, 'm3n4o5p6...', 1760505600000),
  (5, 'q7r8s9t0...', 1760505600000),
  (6, 'u1v2w3x4...', 1760505600000);
```

### 3. 古いテーブルの削除

```sql
DROP TABLE IF EXISTS public._drizzle_migrations;
```

## 検証結果

### Fresh DB での確認

```bash
# 新しいDBコンテナで起動
docker compose down -v && docker compose up -d

# マイグレーション適用
pnpm db:migrate
# → 6 migrations applied successfully
```

### 既存 DB での確認

```bash
# 既存DBで実行
pnpm db:migrate
# → No migrations to apply（正しく履歴が認識されている）
```

## 再発防止

- `drizzle.config.ts` で `migrationsTable: "__drizzle_migrations"` と `migrationsSchema: "drizzle"` を明示指定
- CI で `pnpm db:migrate` を実行し、fresh/既存両環境で green を確認

## 関連ファイル

- `drizzle.config.ts` - migration table 設定
- `drizzle/meta/_journal.json` - migration journal
- `drizzle/0000_01_roles.sql` 〜 `drizzle/0005_10_rate_limit.sql` - migration SQL
- `package.json` - `db:migrate` script

## 実施日

2026-10-10