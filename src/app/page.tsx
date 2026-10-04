const PHASES = [
  { phase: 'Phase 0', title: 'プロジェクト土台', status: '完了' },
  { phase: 'Phase 1', title: 'メール/パスワード認証', status: '未着手' },
  { phase: 'Phase 2', title: 'セキュリティ基盤強化', status: '未着手' },
  { phase: 'Phase 3', title: 'UI / テーマ / 通知 / デバイス管理', status: '未着手' },
  { phase: 'Phase 4', title: 'OAuth（Google / GitHub / Discord）', status: '未着手' },
  { phase: 'Phase 5', title: 'TOTP 2FA + Recovery Codes', status: '未着手' },
  { phase: 'Phase 6', title: 'Passkey / WebAuthn', status: '未着手' },
  { phase: 'Phase 7', title: '管理者 / RBAC / 監査', status: '未着手' },
  { phase: 'Phase 8', title: 'リスク検知 + テスト完成', status: '未着手' },
  { phase: 'Phase 9', title: '運用デプロイ', status: '未着手' },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">oauth</h1>
        <p className="text-muted-fg text-sm">
          超本格アカウント・認証システム — 基盤構築中（Phase 0 完了）
        </p>
      </header>

      <section className="border-border bg-card rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">実装状況</h2>
        <ul className="flex flex-col gap-2">
          {PHASES.map((item) => (
            <li key={item.phase} className="flex items-center justify-between text-sm">
              <span>
                <span className="text-muted-fg">{item.phase}</span> {item.title}
              </span>
              <span className={item.status === '完了' ? 'text-success font-medium' : 'text-muted-fg'}>
                {item.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-border bg-card rounded-lg border p-6">
        <h2 className="mb-2 text-lg font-semibold">この画面について</h2>
        <p className="text-muted-fg text-sm">
          Phase 1 でログイン / 登録画面へ置き換わります。詳細は README.md と docs/phase0-設計.md を参照してください。
        </p>
      </section>
    </main>
  );
}