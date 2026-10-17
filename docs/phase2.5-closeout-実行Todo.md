# M2.5 達成完了のための実行Todo（M2.5 closeout）

> 対象: 仕様書 §69.8（M2.5 完成条件）と `docs/phase2.5-実装計画.md` §5（DoD）に残る差分を潰す。
> 正典の不整合（仕様書 §69.9 と M2.6 実装の矛盾）を最優先で解消し、その後に検証工程的タスクを進める。
> 作成日: 2026-10-17 / 状態: 実施中

---

## 0. 现状把握（2026-10-17 実地監査）

| # | タスク | 現状 | 判定 |
|---|---|---|---|
| 1 | 仕様書 §69.9 と M2.6 の矛盾を解消 | §69.9 は「一般向けのセルフサービス client 登録」を MVP 対象外と明記。一方 M2.6 でセルフサービス登録を実装済。ロードマップ（§Phase 2.5）も「運営者管理下の自作サービス」のまま | ✅ 達成（仕様書 v1.3。§69.4-2 を新設し制約を明記、§69.9 は公開の動的登録と区別して対象外の外へ移した） |
| 2 | `docs/phase2.5-実装計画.md` §0 の進捗更新 | 「26/29 タスク完了」「全 OIDC コードは未コミット」という古い記述が残存 | ✅ 達成（29/29 へ更新、§0.2 の残件表も整理、`実装Todo.md` と README も同期） |
| 3 | P25-E-01 レート制限値の負荷検証 | ✅ 完了（2026-10-17）。`pnpm oidc:load` で実 HTTP 計測、許可数が設定値と厳密一致、5xx 0 件。値は維持 | ✅ 達成 |
| 4 | P25-E-04 migration up/down/restore | ✅ 完了（2026-10-17）。`pnpm db:verify-migrations` で up→down→往復（差分ゼロ）→restore（FKごと復元）を確認。**multi-process 実測のみ Phase 9 へ繰り越し** | ✅ 達成 |
| 5 | P25-E-05 複数 RP での相互運用 | ✅ 完了（2026-10-17）。Go `coreos/go-oidc3` を 2 つ目の RP として追加し独立スタックでの相互運用を確認（2 件 green） | ✅ 達成 |
| 6 | 本番公開の運用 DoD | §69.8 第 5 項。Phase 9 の key management / HTTPS+proxy / access log redaction / monitoring / incident runbook 確認後 | ⏸ Phase 9（仕様が明示的に繰り越している） |

**結論**: M2.5 は **達成**（DoD 6 項中 5 項）。残る未達は「本番公開（Phase 9）」と「multi-process 実測（Phase 9）」の 2 点のみで、機能欠落ではない。

---

## 1. タスク 1 — 仕様書 v1.3 への改訂（正典と実装の整合）

- [x] **C1-01** 仕様書を v1.3 に更新（タイトル・冒頭の版表記）
- [x] **C1-02** §69.9 MVP 対象外を改訂:「一般向けのセルフサービス client 登録」の扱いを、M2.6 で導入した**「本システムにログインした一般ユーザーが自分名義で client を登録できる」**範囲へ緩和する。あわせて**残る MVP 対象外**（第三者開発者のマルチテナント運用、動的 client registration、refresh token 等）は明確に残す。要件は弱めず、制約（https 必須 redirect URI・上限・レート制限・同意画面での登録者開示・再認証）を明示する
- [x] **C1-03** §Phase 2.5 ロードマップに M2.6（管理コンソール）を追記し、対象範囲にセルフサービス登録を含むと明記
- [x] **C1-04** §69 本文に「client 登録は管理画面（セルフサービス）または operator CLI から行う。管理画面からの登録には所有者・上限・再認証の制約を適用する」旨を追記し、§69.8 完成条件に「登録者の同意画面での開示」を 1 項目追加
- [x] **C1-05** §59 OIDC Provider（M2.5）のテスト観点リストへ、セルフサービス登録由来の観点（登録者なりすまし / IDOR / 大量登録 / secret 漏えい）を追記
- [x] **C1-06** 改訂履歴に v1.3 行を追加（変更内容と反映先 `docs/phase2.6-oidc-client-console-実装計画.md`）

## 2. タスク 2 — phase2.5 実装計画の進捗更新

- [x] **C2-01** `docs/phase2.5-実装計画.md` §0 の件数・残件・未コミット表述を実態（27/29、main マージ済）に更新
- [x] **C2-02** 同 §0.2「未達タスクの残件」表を、残る E-01/E-04/E-05 のみに整理（既に解消済みの A/B/C/D/E 各項目を完了へ移動）
- [x] **C2-03** 同チェックボックス（P25-E-01/E-04/E-05）の部分完了内容を反映
- [x] **C2-04** `実装Todo.md` の M2.5 マイルストーン行を実態に更新（M2.6 行と併記）

## 3. タスク 3 — P25-E-01 レート制限値の負荷検証

- [x] **C3-01** 負荷検証スクリプト `scripts/oidc-load-test.ts` を作成（authorize / token / userinfo / revoke / interaction の各エンドポイントへ並列リクエストを撃ち、RPS・レイテンシ・429 発生点を計測）
- [x] **C3-02** 計測を実行し、結果を `docs/phase2.5-load-test.md` に記録。許可数が全シナリオで設定値と厳密一致（30/60/30/90/10）、5xx は 0 件
- [x] **C3-03** **全 5 種の値を維持**（authorize 30/10分・interaction 60/10分・token 30/分・userinfo 90/分・revoke 10/分）。判断根拠は `docs/phase2.5-load-test.md` §3.2。`src/config/rate-limits.ts` の変更は不要
- [x] **C3-04** 計測完了（値の変更がないため既存テストへの影響なし。`pnpm lint` / `typecheck` green を確認）

## 4. タスク 4 — P25-E-04 migration up/down/restore

- [x] **C4-01** `scripts/verify-migrations.ts`（`pnpm db:verify-migrations`）を新規作成。一時 DB で up を適用し、13 テーブル・7 CHECK・12 FK・42 index と migration 0010〜0013 の要点を個別検証
- [x] **C4-02** 全 14 migration を逆順に roll back しテーブルが 1 つも残らないことを確認。down 後に再度 up を適用し、テーブル・列・index・CHECK・FK のスナップショットに差分がないことを確認
- [x] **C4-03** users / oauth_clients（owner_user_id の FK 関係含む）を入れ、`pg_dump -Fc` → 別 DB へ `pg_restore` してデータが一致することを確認
- [x] **C4-04** 結果を `docs/phase2.5-migration.md` に記録。migration 0012（secret_ciphertext 削除）が不可逆であり、ロールバック時は全 confidential client の secret ローテーションが必要である旨も明記

## 5. タスク 5 — P25-E-05 複数 RP での相互運用

- [x] **C5-01** 2 つ目の RP は **Go / `coreos/go-oidc3` v3.21.0** に決定（Node `openid-client` とは完全に独立したスタック。2026-10-17 に利用者と合意）
- [x] **C5-02** `interop/rp-go/main.go` を実装し、Discovery→code 交換→ID Token の署名/issuer/audience/nonce 検証→UserInfo を実通信で確認。`src/test/e2e/oidc-interop-go.test.ts` 2 件 green
- [x] **C5-03** 結果を `docs/phase2.5-interop.md` に記録し、`docs/phase2.5-review.md` §7 へ完了記録と追加欠陥を追記

## 6. タスク 6 — M2.5 DoD 判定

- [x] **C6-01** §69.8 と `phase2.5-実装計画.md` §5.1 の全 6 項目を再判定（5 項目達成、1 項目は Phase 9 へ繰り越し）。M2.5 を **29/29 タスク完了・達成**へ更新。残る 2 点（multi-process 実測・本番公開）を §0.4 に明記
- [x] **C6-02** `pnpm lint`（0 error）/ `typecheck` green / `test`（43 ファイル 262 件）/ `test:e2e`（3 ファイル 12 件、Go 相互運用を含む）/ `build` green を最終確認
