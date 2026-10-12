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
      subject: 'アカウント確認のお願い',
      html: (url: string) => `<p>以下のボタンをクリックして確認してください。</p><p><a href="${url}">確認</a></p>`,
      text: (url: string) => `以下のURLを確認してください。\n${url}`,
    },
    resend: {
      subject: '確認メールの再送信',
      html: (url: string) => `<p>以下のボタンをクリックして確認してください。</p><p><a href="${url}">確認</a></p>`,
      text: (url: string) => `以下のURLを確認してください。\n${url}`,
    },
    passwordReset: {
      subject: 'パスワードリセットのお願い',
      html: (url: string, meta: { ip: string; time: string }) =>
        `<p>以下のボタンをクリックしてパスワードをリセットしてください。</p><p><a href="${url}">リセット</a></p><p>参考: IP ${meta.ip}, ${meta.time}</p>`,
      text: (url: string, meta: { ip: string; time: string }) =>
        `以下のURLを確認してください。\n${url}\n参考: IP ${meta.ip}, ${meta.time}`,
    },
    securityNotification: {
      subject: 'セキュリティ通知',
      html: (data: { device: string; ip: string; time: string }) =>
        `<p>新しいログインがあります。</p><p>デバイス: ${data.device}, IP: ${data.ip}, ${data.time}</p>`,
      text: (data: { device: string; ip: string; time: string }) =>
        `新しいログインがあります。\nデバイス: ${data.device}, IP: ${data.ip}, ${data.time}`,
    },
    changeNotification: {
      subject: 'アカウント変更通知',
      html: (data: { change: string; time: string; ip: string }) =>
        `<p>アカウントが変更されました。</p><p>変更: ${data.change}, ${data.time}, IP: ${data.ip}</p>`,
      text: (data: { change: string; time: string; ip: string }) =>
        `アカウントが変更されました。\n変更: ${data.change}, ${data.time}, IP: ${data.ip}`,
    },
    accountDeletion: {
      subject: 'アカウント削除のお知らせ',
      html: () => `<p>アカウントは削除されます。30日間保持後、完全に削除されます。</p>`,
      text: () => `アカウントは削除されます。30日間保持後、完全に削除されます。`,
    },
  },
} as const;