# Phase 10 メール認証の復旧手順

Phase 10（`docs/phase10-メール認証廃止-実装計画.md` / D-40-01〜06）で**サイトから廃止**した
メールによる認証を、メール送受信が再び使えるようになったときに戻すための手順。

> **要点**: Phase 10 は「設定スイッチで ON/OFF」する作りにはしていない。戻す手段は
> **git で Phase 10 の差分を巻き戻す（revert）**こと。UI・API・lib はすべてリポジトリに残っている
> ため、巻き戻しで概ね元に戻る。ただし §4 の「不可逆な点」だけは手当てが必要。

対象コミット（`main` の履歴）:

| コミット | 内容 |
|---|---|
| `02166b2` | PR #48 のマージコミット（この revert が本命） |
| `f539312` | OIDC `email_verified` を常に false にする修正（D-40-06） |
| `5ff7d43` | レビュー指摘対応（登録後導線・文言・OIDC 制約の明記） |
| `3972268` | Phase 10 本体（D-40-01〜05） |

---

## 1. いちばん簡単な戻し方（推奨）

> **⚠️ どの戻し方でも共通の前提**: revert は `src/lib/oidc/provider.ts` を
> `email_verified = true`（＝保存値をそのまま返す形）に戻す。しかし migration `0024` で有効化された
> 既存ユーザーと Phase 10 中に作成されたアカウントは、**メール所有確認を経ずに** `email_verified=true` を
> 持っている。この集団を修復（所有確認を完了させるか OIDC 対象から除外）するまで、revert した
> provider を本番へ出してはいけない。§4 と §2 の手順 1 を先に済ませること。間に合わせたい場合は、
> revert 後も `claims.email_verified` を `false` に固定したままデプロイする（所有確認が済むまで）。

PR #48 のマージコミットを revert する。ブランチを切ってから作業する。

```bash
git switch -c revert/phase10-restore-email-auth main
# -m 1 で「マージの第1親（main 側）」に対して巻き戻す＝PR #48 の取り込みだけを打ち消す
git revert -m 1 02166b2
```

これで次が一度に戻る。

- 削除した画面 13 ファイル（`/forgot-password`・`/reset-password`・`/verify-email`・
  `/email-change/confirm`・`/account/delete/confirm` と各フォーム、`email-unverified-notice`、
  `email-change-panel`）
- `register` の即時有効化（`email_verified=true` / `status='active'`）→ 従来の `pending_email` 作成＋確認メール送信
- `login` / `2fa/setup` / `passkey/register/options` / `passkey/login/verify` / `password/set` の
  `email_verified` ゲート（403 `EMAIL_NOT_VERIFIED`）
- `auth-form.tsx` の Discord 連絡モーダル → 従来の `/forgot-password` リンク
- `middleware.ts` の `no-store` 対象、`messages/ja.ts` の文言、関連テスト

> **衝突が出たら**: `f539312`（OIDC）や `5ff7d43`（ドキュメント）は Phase 10 の後続コミット。
> revert が競合した場合は §2 の個別 revert に切り替える。

revert 後に必ず流す:

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm db:verify-migrations
```

---

## 2. 個別に戻す（revert が競合したとき）

Phase 10 の本体だけを戻し、レビュー対応コミットは残したい場合はこちら。

```bash
git switch -c revert/phase10-restore-email-auth main
git revert 3972268        # Phase 10 本体（D-40-01〜05）だけを巻き戻す
```

`f539312`（OIDC `email_verified` を常に false にする変更）は、**次の順で**戻す。順序が逆だと
「所有確認が済んでいないのに `email_verified=true` を返す」状態を一瞬でも作ってしまう。

1. **データ修復**: migration `0024` で有効化された既存ユーザーと、Phase 10 中に作成された
   アカウントについて、メール所有確認を完了させる（または OIDC の対象から除外する）まで、
   `email_verified` を `true` に戻さない。§4 の不可逆点を先に手当てする。
2. **実装の復元**: `src/lib/oidc/provider.ts` の claims callback を、固定値ではなく
   **ユーザーごとに永続化された確認状態**（`users.email_verified`）を返す形に戻す。
   Phase 10 では `claims.email_verified = false;` に固定していた。
3. **表示・テストの更新**: 同意画面（`scripts/server.ts` の `claimLabels.email`）の文言と、
   `oidc-flow` / `oidc-interop-go` / `client-console` の期待値を更新する。

> D-40-06 は「メールを復旧したら所有確認を戻すこと」を明記している（計画 §決定事項）。
> 手順 1（データ修復）が済むまでは `email_verified` を `true` に戻さないこと。

---

## 3. 部分ごとに戻す（revert を使わない）

画面だけ戻したい / 登録だけ戻したい場合は、削除前のファイルを git から取り出して当てる。

```bash
# 削除した画面を取り出す（1 ファイルずつ）。git restore は親ディレクトリも作るので、
# 削除済みのパスへでも `>` リダイレクトのように失敗しない。
git restore --source=3972268^ -- src/app/forgot-password/page.tsx
# ディレクトリごと戻す場合
git checkout 3972268^ -- src/app/forgot-password src/app/reset-password \
  src/app/verify-email src/app/email-change/confirm src/app/account/delete/confirm \
  src/app/verify-email-form.tsx src/components/auth/email-unverified-notice.tsx \
  src/components/settings/email-change-panel.tsx
```

`3972268^`（＝Phase 10 直前の `5511082`）に削除前の全ファイルが残っている。戻したら
`register` / `login` のロジック（§1 に列挙した差分）も併せて戻す必要がある点に注意。

---

## 4. 不可逆な点（revert では戻らない・手当てが必要）

| 項目 | 内容 | 手当て |
|---|---|---|
| **migration `0024` のデータ変更** | 既存の `pending_email` ユーザーを `email_verified=true` / `status='active'` に**一度だけ**更新した。revert してもこのデータ変更は戻らない | **migration 実行前のバックアップまたは対象 ID 一覧を正本**として対象集合を作る。`security_events` の `register` / `email_verified` 履歴は**照合用の補助情報にとどめる**。対象集合の全件性を証明できない場合は完了扱いにしない |
| **Phase 10 中のアカウント** | 新規登録が常に `email_verified=true` になるため、値だけでは Phase 10 中の登録を区別できない | Phase 10 の登録経路が有効だった**開始・終了時刻を記録**し、`users.created_at` がその期間に入る行を抽出する。保持されていない分はバックアップから補完する |
| **完了判定（ゲート）** | 対象集合の全件性または所有確認・OIDC 除外の証跡が不完全な場合がある | **証跡が不完全なら完了扱いにせず、`email_verified` を `false` 固定のまま**デプロイする（§1 の前提を参照） |
| **OIDC の `email_verified`** | 巻き戻し前は外部 RP へ常に `false` を返していた（D-40-06） | §2 のとおり `provider.ts` を戻す。RP 側でメールを信頼していた場合はその間に連携が成立していない可能性がある |
| **フィーチャーフラグは無い** | `EMAIL_AUTH_ENABLED` のような環境変数スイッチは存在しない | 「設定で切り替え」たい場合は、別途フラグ化と `email_verified` ゲートの一元化（`requireEmailVerified()` など）を実装する |

---

## 5. 復旧後に確認すること

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` green
- [ ] `pnpm db:migrate` が通る（revert で migration が戻った場合、`0024` の再適用は起きない点に注意）
- [ ] `pnpm db:verify-migrations`（up / down / 往復 / restore）green
- [ ] 登録 → 確認メール受信 → `/verify-email` で `email_verified=true` → ログイン可、を実機で確認
- [ ] 未確認 email でログインすると 403 `EMAIL_NOT_VERIFIED` に戻っている
- [ ] `/forgot-password` → メール受信 → `/reset-password` でパスワード再設定できる
- [ ] メール送信の環境変数（`RESEND_API_KEY` / `EMAIL_FROM`）が設定済み（未設定だと送信で失敗する）
- [ ] **（前提）** migration `0024` 対象＋Phase 10 中のアカウントの**対象集合を正本（migration 前バックアップ or 対象 ID 一覧＋登録経路の有効期間）から確定**し、所有確認（または OIDC 対象からの除外）を完了している。全件性の証跡が不完全なら `email_verified` は `false` 固定のままにする（§4）
- [ ] OIDC の `email_verified` を戻した場合、`oidc-flow` / `oidc-interop-go` / `client-console` が green

---

## 6. 関連ドキュメント

- `docs/phase10-メール認証廃止-実装計画.md` — Phase 10 の決定事項（D-40-01〜06）と実装内容
- `docs/phase9-運用ランブック.md` — §54 / §55 の手動復旧フロー（運用側の手順）
- `docs/phase9-バックアップ復元手順.md` — DB のバックアップ / 復元
