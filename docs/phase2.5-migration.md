# P25-E-04 結果 — migration の可逆性と restore の検証

**実施日**: 2026-10-17
**手段**: `pnpm db:verify-migrations`（`scripts/verify-migrations.ts`）
**対象**: `drizzle/0000` 〜 `drizzle/0013`（全 14 migration）

---

## 1. 検証内容

| # | 検証 | 方法 |
|---|---|---|
| 1 | **up** | 一時 DB を作成し `drizzle-kit migrate` を適用。13 テーブル・7 CHECK 制約・12 外部キー・42 インデックスが生成されることを確認 |
| 2 | **スキーマ妥当性** | migration 0010〜0013 の要点（operator 列、secret_hash、secret_ciphertext の削除、owner_user_id とその外部キー、openid/scope/secret の CHECK、論理削除を許容する partial unique index）を個別に検証 |
| 3 | **down** | `drizzle/meta/_journal.json` から migration 一覧を読み、逆順に roll back。生成されるオブジェクトを削除し、テーブルが 1 つも残らないことを確認 |
| 4 | **往復** | down 後に再度 up を適用し、テーブル・列・インデックス・CHECK・外部キーのスナップショットが手順 1 と完全一致することを確認 |
| 5 | **restore** | テストデータ（users / oauth_clients と owner_user_id の外部キー関係）を入れ、`pg_dump -Fc` → 別 DB へ `pg_restore` してデータが一致することを確認 |

> down migration は drizzle-kit が生成しない（このプロジェクトは up のみ保持している）ため、スクリプトが各 migration の up 文から生成したオブジェクトを逆順に取り消す方式で検証した。自動生成が対応していない文型に出た場合は**エラーで停止**するため、「静かに通過して検査をすり抜ける」ことはない。

---

## 2. 実行結果

```
## 1. up（全 migration 適用）
- テーブル数: 13 (email_change_requests, email_verification_tokens, oauth_clients,
  oidc_artifacts, oidc_user_grants, oidc_user_subjects, password_reset_tokens,
  rate_limit_hits, rate_limit_reservations, roles, security_events, sessions, users)
- CHECK 制約数: 7
- 外部キー数: 12
- インデックス数: 42
- ✅ users / oauth_clients / oidc_artifacts / rate_limit_reservations テーブルが存在する
- ✅ oauth_clients.owner_user_id 列がある（migration 0013）
- ✅ oauth_clients.secret_hash 列がある（migration 0011）
- ✅ oauth_clients.secret_ciphertext 列が無い（migration 0012）
- ✅ oauth_clients に owner_user_id の外部キーがある
- ✅ oauth_clients に type/openid/scope/secret の CHECK がある
- ✅ users に status/email_verified の CHECK がある
- ✅ 論理削除を許容する partial unique index がある

## 2. down（全 migration を逆順に roll back）
- 残存テーブル: (なし)

## 3. 往復（down 後に再度 up）
- ✅ up → down → up でスキーマ差分なし

## 4. restore（pg_dump → pg_restore）
- 復元手段: container pg_dump/pg_restore
- clients=1 users=1 owner_user_id=usr_restore_check
- ✅ pg_dump → pg_restore でデータと外部キー関係が復元できた

# 結果: up / down / 往復 / restore のすべてが成功
```

---

## 3. 判定と所見

### 3.1 可逆性

- 全 14 migration を逆順に roll back でき、**テーブル・制約・インデックス・外部キーが完全に消える**ことを確認した
- `up → down → up` の往復でスキーマスナップショットに差分が出ないため、migration の適用順やデータ移行（migration 0011 の `token_endpoint_auth_method` 更新、0012 の列削除）に順序依存の破損がない
- migration 0012（`secret_ciphertext` の削除）は**不可逆**である点に注意。down で戻しても元の平文暗号化列は復元できず、0011 が設定する `hmac-sha256:invalidated-rotate-required` の値が残る。これは意図的な設計（secret を平文に戻さない）であり、ロールバック時は**全 confidential client の secret ローテーションが必要**になる旨を運用に明記すること

### 3.2 restore

- `pg_dump -Fc` / `pg_restore` で users・oauth_clients の行と `owner_user_id` の外部キー関係が完全に復元できた
- 本検証は custom format の dump/restore のみを確認する。本番で採用する**ポイントインタイムリカバリ（PITR）や論理バックアップの保管戦略・保持期間は Phase 9 の運用 DoD の対象**であり、本件には含めない

### 3.3 multi-process について

migration の可逆性・restore と multi-process は別項目のため、`docs/phase2.5-closeout-実行Todo.md` の C4 完了记录に残す。adapter は PostgreSQL を正本とする設計（`src/lib/oidc/adapter.ts`）であり、`oidc_artifacts` の消費は `UPDATE ... WHERE consumed_at IS NULL` の原子的 1 回消費、code の並行交換 1 回のみ成功は `src/test/integration/oidc-persistence.test.ts` で確認済み。複数プロセス起動での実測は本検証の範囲外であり、Phase 9 の運用検証で必要に応じて実施する。

---

## 4. 再現方法

```bash
pnpm db:verify-migrations
```

- 一時データベース（`migration_check_<random>` と `_restore`）を作成し、終了時に削除する
- アプリケーションデータには触らない
- ホストに `pg_dump` があればそちらを使い、なければコンテナ内の `pg_dump` にフォールバックする

---

## 5. 対応するタスク

- [x] P25-E-04: migration up/down/restore の可逆性検証
