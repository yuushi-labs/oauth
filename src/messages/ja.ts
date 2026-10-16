import { APP_NAME } from '@/config/app';
import { emailButton, emailLayout, escapeHtml } from '@/lib/auth/email/layout';

export const messages = {
  errors: {
    INVALID_CREDENTIALS: '認証情報が正しくありません。',
    EMAIL_TAKEN: 'このメールアドresaは使用できません。',
    RATE_LIMITED: 'リクエストが多すぎます。一段时间してからお試しください。',
    REAUTH_REQUIRED: '本人確認が必要です。',
    INVALID_TOKEN: 'リンクが無効か、有効期限が切れています。',
    SESSION_EXPIRED: 'セッションの有効期限が切れました。',
    ACCOUNT_SUSPENDED: 'このアカウントは利用できません。',
    VALIDATION_ERROR: '入力内容を確認してください。',
    INTERNAL_ERROR: 'エラーが発生しました。',
    CSRF_FAILED: 'リクエストを検証できませんでした。',
    INVALID_PROVIDER: '指定された認証プロバイダーは利用できません。',
    INVALID_STATE: '認証リクエストを検証できませんでした。もう一度お試しください。',
    INVALID_CODE: '認証コードが正しくありません。',
  },
  auth: {
    register: '確認メールを送信しました',
    login: 'ログインしました',
    logout: 'ログアウトしました',
    verifyEmail: 'メールアドresaが認証されました',
    resendVerification: '確認メールを再送信しました',
    passwordReset: 'パスワードがリセットされました',
    passwordChanged: 'パスワードを変更しました',
    passwordSet: 'パスワードを設定しました',
    reauth: '再認証完了',
    emailChange: '変更通知メールを送信しました',
    emailChangeConfirm: 'メールアドresaを変更しました',
    accountDelete: 'アカウントを削除しました',
    accountDeleting: 'アカウントは削除されます（30日間保持）',
  },
  emails: {
    verification: {
      subject: `${APP_NAME}: メールアドレスを確認してください`,
      html: (url: string) => emailLayout('メールアドレスの確認', `<p>${escapeHtml(APP_NAME)}へのご登録ありがとうございます。下のボタンからメールアドレスを確認してください。</p>${emailButton(url, 'メールアドレスを確認する')}<p style="color:#64748b;font-size:13px">このリンクは30分間有効です。</p>`),
      text: (url: string) => `${APP_NAME}へのご登録ありがとうございます。以下のURLからメールアドレスを確認してください（30分間有効）。\n${url}`,
    },
    resend: {
      subject: `${APP_NAME}: 確認メール`,
      html: (url: string) => emailLayout('メールアドレスの確認', `<p>メールアドレスの確認を完了するには、下のボタンを押してください。</p>${emailButton(url, 'メールアドレスを確認する')}<p style="color:#64748b;font-size:13px">このリンクは30分間有効です。</p>`),
      text: (url: string) => `${APP_NAME}のメールアドレス確認リンクです（30分間有効）。\n${url}`,
    },
    passwordReset: {
      subject: `${APP_NAME}: パスワードを再設定してください`,
      html: (url: string, meta: { ip: string; time: string }) =>
        emailLayout('パスワードの再設定', `<p>パスワードを再設定するには、下のボタンを押してください。</p>${emailButton(url, 'パスワードを再設定する')}<p style="padding:12px 16px;background:#f8fafc;border-radius:8px;color:#64748b;font-size:13px">リクエスト元 IP: ${escapeHtml(meta.ip)}<br>リクエスト日時: ${escapeHtml(meta.time)}</p>`),
      text: (url: string, meta: { ip: string; time: string }) =>
        `パスワードを再設定するには以下のURLを開いてください。\n${url}\nリクエスト元 IP: ${meta.ip}\nリクエスト日時: ${meta.time}`,
    },
    securityNotification: {
      subject: `${APP_NAME}: セキュリティ通知`,
      html: (data: { device: string; ip: string; time: string }) =>
        emailLayout('新しいログインを検知しました', `<p>アカウントへの新しいログインがありました。</p><p style="padding:12px 16px;background:#f8fafc;border-radius:8px;color:#475569">デバイス: ${escapeHtml(data.device)}<br>IPアドレス: ${escapeHtml(data.ip)}<br>日時: ${escapeHtml(data.time)}</p>`),
      text: (data: { device: string; ip: string; time: string }) =>
        `新しいログインがあります。\nデバイス: ${data.device}, IP: ${data.ip}, ${data.time}`,
    },
    changeNotification: {
      subject: `${APP_NAME}: アカウント変更通知`,
      html: (data: { change: string; time: string; ip: string }) =>
        emailLayout('アカウント情報が変更されました', `<p>次の変更が行われました。</p><p style="padding:12px 16px;background:#f8fafc;border-radius:8px;color:#475569">変更内容: ${escapeHtml(data.change)}<br>日時: ${escapeHtml(data.time)}<br>IPアドレス: ${escapeHtml(data.ip)}</p>`),
      text: (data: { change: string; time: string; ip: string }) =>
        `アカウントが変更されました。\n変更: ${data.change}, ${data.time}, IP: ${data.ip}`,
    },
    accountDeletion: {
      subject: `${APP_NAME}: アカウント削除のお知らせ`,
      html: () => emailLayout('アカウント削除のお知らせ', '<p>アカウントは削除予定です。30日間の保持期間後に完全に削除されます。</p>'),
      text: () => `${APP_NAME}のアカウントは削除予定です。30日間の保持期間後に完全に削除されます。`,
    },
  },
} as const;
