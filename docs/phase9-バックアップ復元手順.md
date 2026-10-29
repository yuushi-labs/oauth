# Phase 9 バックアップ / 復元手順

> 対象: §53（バックアップ・復元テスト）/ Phase 9（P9-A-02〜04）
> 正本: 仕様書 §53 → `docs/phase9-運用デプロイ-実装計画.md`（D-39-02 / D-39-03）→ 本書
> 初版: 2026-10-29

バックアップは**取れても復元できなければ意味が無い**。本手順は「復元テストの実施」までを
含めて 1 サイクルとする（D-39-02）。

---

## 1. 鍵の準備

- `BACKUP_ENCRYPTION_KEY`（Base64 32 バイト）を Secret Manager へ登録する。
- 生成例:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

- **鍵が未設定だと `pnpm backup` は失敗する**（平文でバックアップしない・D-39-03）。
- 鍵はコード・リポジトリ・チャットへ残さない。旧鍵は、旧バックアップが不要になるまで保管する。

---

## 2. バックアップ

```bash
# 既定: ./backups へ、保持 30 日で取得
pnpm backup

# 出力先と保持日数を指定
pnpm backup --out /srv/backups --keep 30
```

- 出力: `backup-<ISO8601>.dump.enc`（AES-256-GCM、権限 `0o600`）。
- 平文の `pg_dump` は一時ファイルにも残さない（パイプで受けて暗号化する）。
- 保持期間を過ぎたバックアップは同じ実行内で削除される（pruning）。

---

## 3. 復元

```bash
# 本番 DB へ流さないこと。復元先は必ず明示する。
pnpm restore --file /srv/backups/backup-2026-10-29T03-15-00-000Z.dump.enc \
             --database postgresql://app:***@db-internal:5432/app_restore
```

- `--database` を省略すると `DATABASE_URL`（＝本番）へ復元する。**原則として指定する**。
- `--clean --if-exists` で既存オブジェクトを置き換える（同一 DB への再復元を許容）。
- 復号したダンプは標準入力で `pg_restore` へ渡し、一時ファイルに残さない。

---

## 4. 復元テスト（必須・§53）

**四半期ごと**、またはスキーマ変更のたびに、以下を実施し記録する。

1. 一時 DB を作成する。
   ```bash
   createdb -h db-internal -U app app_restore_test
   ```
2. 直近のバックアップを一時 DB へ復元する。
   ```bash
   pnpm restore --file /srv/backups/<最新>.dump.enc \
                --database postgresql://app:***@db-internal:5432/app_restore_test
   ```
3. 主要テーブルの行数・最新行を確認する。
   ```bash
   psql "postgresql://app:***@db-internal:5432/app_restore_test" \
     -c "SELECT count(*) FROM users; SELECT count(*) FROM security_events;"
   ```
4. 一時 DB を削除する。
   ```bash
   dropdb -h db-internal -U app app_restore_test
   ```
5. 結果を下表へ記録する。

> この手順は統合テスト `src/test/integration/ops-backup-restore.test.ts` でも自動化されている
> （実 `pg_dump` / `pg_restore` で一時 DB へ復元し、行数を検証する）。

### 実施記録

| 日付 | 実行者 | バックアップ | 復元先 | 行数確認 | 結果 | 備考 |
|---|---|---|---|---|---|---|
| （例）2026-10-29 | 運用 | backup-2026-10-29T03-15-00-000Z.dump.enc | app_restore_test | users=…, security_events=… | ✅ | 四半期定例 |

---

## 5. トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY が未設定です` | 鍵未注入 | Secret Manager から注入する（平文では保存しない） |
| `Unsupported state or unable to authenticate data` | 鍵不一致 or ファイル改竄 | 正しい鍵を確認する。改竄の疑いがあれば新しいバックアップを使う |
| `pg_dump exited with …` | 接続失敗 / 権限不足 | `DATABASE_URL` と DB の権限を確認する |
| 復元後にデータが古い | 保持期間内の別バックアップ | 目的の日時のファイル名を確認して指定する |
