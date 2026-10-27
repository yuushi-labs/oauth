import { APP_NAME } from '@/config/app';
import { emailButton, emailLayout, escapeHtml } from '@/lib/auth/email/layout';

export const messages = {
  errors: {
    // API エラーコードに対応する既定メッセージ（ERROR_CODES と 1 対 1）
    INVALID_CREDENTIALS: '認証情報が正しくありません。',
    EMAIL_TAKEN: 'このメールアドレスは使用できません。',
    RATE_LIMITED: 'リクエストが多すぎます。しばらくしてからお試しください。',
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
    ACCOUNT_ALREADY_LINKED: 'このプロバイダーは既に連携されています。',
    ACCOUNT_LINKED_ELSEWHERE: 'この認証情報は既に別のアカウントで使われています。',
    ACCOUNT_NOT_LINKABLE: 'この認証情報ではログインも新規登録もできません。',
    EMAIL_CONFLICT: 'このメールアドレスは別のアカウントに登録済みです。',
    LAST_LOGIN_METHOD: '最後のログイン手段は解除できません。',
    TOTP_REQUIRED: '2 段階認証を完了してください。',
    TOTP_ALREADY_ENABLED: '2 段階認証は既に有効です。',
    EMAIL_NOT_VERIFIED: 'メールアドレスの確認が必要です。',
    CREDENTIAL_ALREADY_REGISTERED: 'このパスキーは既に登録されています。',
    FORBIDDEN: 'この操作を行う権限がありません。',
    ADMIN_2FA_REQUIRED: '管理者は 2 段階認証の有効化が必要です。',
    CANNOT_TARGET_SELF: '自分自身に対してこの操作はできません。',
    ADMIN_NOT_FOUND: '対象のユーザーが見つかりません。',
    LAST_ADMIN: '最後の管理者は降格できません。',
  },
  auth: {
    register: '確認メールを送信しました',
    login: 'ログインしました',
    logout: 'ログアウトしました',
    verifyEmail: 'メールアドレスが認証されました',
    resendVerification: '確認メールを再送信しました',
    passwordReset: 'パスワードがリセットされました',
    passwordChanged: 'パスワードを変更しました',
    passwordSet: 'パスワードを設定しました',
    reauth: '再認証完了',
    emailChange: '変更通知メールを送信しました',
    emailChangeConfirm: 'メールアドレスを変更しました',
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
      subject: `${APP_NAME}: 新しいログインを検知しました`,
      html: (data: { device: string; ip: string; time: string; region?: string | null }) => {
        // 地域は値があるときだけ行を出す。未定の値を「不明」と書き出さない（Phase 8/9 で geo-IP を接続想定）。
        const region = data.region ? `<br>地域: ${escapeHtml(data.region)}` : '';
        return emailLayout(
          '新しいログインを検知しました',
          `<p>アカウントへの新しいログインがありました。</p>` +
            `<p style="padding:12px 16px;background:#f8fafc;border-radius:8px;color:#475569">` +
            `デバイス: ${escapeHtml(data.device)}<br>IPアドレス: ${escapeHtml(data.ip)}${region}<br>日時: ${escapeHtml(data.time)}</p>` +
            `<p>心当たりがない場合は、パスワードを変更し、すべてのデバイスからログアウトしてください。</p>`,
        );
      },
      text: (data: { device: string; ip: string; time: string; region?: string | null }) => {
        const region = data.region ? `\n地域: ${data.region}` : '';
        return `新しいログインがあります。\nデバイス: ${data.device}\nIP: ${data.ip}${region}\n日時: ${data.time}\n\n心当たりがない場合は、パスワードを変更し、すべてのデバイスからログアウトしてください。`;
      },
    },
    changeNotification: {
      subject: `${APP_NAME}: アカウント変更通知`,
      html: (data: { change: string; time: string; ip: string }) =>
        emailLayout(
          'アカウント情報が変更されました',
          `<p>次の変更が行われました。</p><p style="padding:12px 16px;background:#f8fafc;border-radius:8px;color:#475569">変更内容: ${escapeHtml(data.change)}<br>日時: ${escapeHtml(data.time)}<br>IPアドレス: ${escapeHtml(data.ip)}</p><p>心当たりがない場合は、速やかにパスワードを変更してください。</p>`,
        ),
      text: (data: { change: string; time: string; ip: string }) =>
        `アカウントが変更されました。\n変更: ${data.change}\n日時: ${data.time}\nIP: ${data.ip}\n\n心当たりがない場合は、速やかにパスワードを変更してください。`,
    },
    accountDeletion: {
      subject: `${APP_NAME}: アカウント削除のお知らせ`,
      html: () => emailLayout('アカウント削除のお知らせ', '<p>アカウントは削除予定です。30日間の保持期間後に完全に削除されます。</p>'),
      text: () => `${APP_NAME}のアカウントは削除予定です。30日間の保持期間後に完全に削除されます。`,
    },
  },
  ui: {
    settings: {
      title: '設定',
      menu: '設定メニュー',
      account: 'アカウント',
      connectedApps: '接続済みサービス',
      applications: 'アプリケーション',
      security: 'セキュリティ',
      sessions: 'セッション',
      appearance: '外観',
      password: 'パスワード',
      connectedAccounts: '連携アカウント',
      admin: '管理',
    },
    admin: {
      title: '管理',
      users: 'ユーザー管理',
      auditLogs: '監査ログ',
      usersHint: 'ユーザーの権限変更・停止・削除を行います。操作はすべて監査ログに記録されます。',
      auditLogsHint: '管理者操作の記録です。この一覧は読み取り専用です。',
      twoFactorRequired: '管理機能を使うには 2 段階認証の有効化が必要です。',
      twoFactorRequiredHint: 'セキュリティ設定から 2 段階認証を有効化してください。',
      goToSecurity: 'セキュリティ設定へ',
      user: 'ユーザー',
      email: 'メールアドレス',
      status: '状態',
      role: '権限',
      twoFactor: '2FA',
      passkey: 'パスキー',
      createdAt: '登録日',
      actions: '操作',
      changeRole: '権限を変更',
      suspend: '停止',
      unsuspend: '停止を解除',
      revokeSessions: 'セッションを失効',
      delete: '削除',
      roleChanged: '権限を変更しました。',
      suspended: 'ユーザーを停止しました。',
      unsuspended: '停止を解除しました。',
      sessionsRevoked: 'セッションを失効させました。',
      deleted: 'ユーザーを削除しました。',
      confirmDelete: 'このユーザーを削除しますか？',
      noUsers: 'ユーザーがいません。',
      noAuditLogs: '監査ログはまだありません。',
      totalCount: '合計 {n} 件',
      actor: '実行者',
      target: '対象',
      action: '操作',
      ipMasked: 'IP',
      detail: '詳細',
      enabled: '有効',
      disabled: '無効',
      roleLabels: {
        role_user: '一般ユーザー',
        role_moderator: 'モデレーター',
        role_admin: '管理者',
        role_superadmin: '最上位管理者',
      } as Record<string, string>,
      actionLabels: {
        admin_user_viewed: 'ユーザー一覧を閲覧',
        admin_user_suspended: 'ユーザーを停止',
        admin_user_unsuspended: '停止を解除',
        admin_session_revoked: 'セッションを失効',
        admin_account_deleted: 'アカウントを削除',
        admin_role_changed: '権限を変更',
      } as Record<string, string>,
    },
    common: {
      or: 'または',
      cancel: 'キャンセル',
      close: '閉じる',
      copy: 'コピー',
      copied: 'コピーしました',
      loading: '読み込み中…',
      saving: '保存中…',
      retry: '再試行',
      backToLogin: 'ログインに戻る',
      error: '操作に失敗しました。もう一度お試しください。',
    },
    theme: {
      title: 'テーマ',
      system: 'システムに追従',
      light: 'ライト',
      dark: 'ダーク',
      systemHint: '端末の設定に合わせます',
      lightHint: '常にライト表示にします',
      darkHint: '常にダーク表示にします',
      selected: '選択中',
      toggleLabel: 'テーマの切り替え',
      currentPreference: '現在の設定',
      currentResolved: '現在は{value}で描画されています',
      saveFailed: 'テーマの設定を保存できませんでした。前の設定に戻しました。',
    },
    pwStrength: {
      guide: '8 文字以上 128 文字以下で入力してください',
      veryWeak: '非常に弱い',
      weak: '弱い',
      fair: '普通',
      good: '強い',
      strong: '非常に強い',
      label: 'パスワードの強度',
      reusedWarning: '他のサービスと使い回さないでください',
      mismatch: 'パスワードが一致しません',
    },
    reauth: {
      title: '本人確認',
      description: '重要な操作のため、現在のパスワードで本人確認を行います。',
      passwordLabel: '現在のパスワード',
      submit: '本人確認する',
      failed: 'パスワードが正しくありません',
      cancelled: '操作を中止しました',
    },
    twoFactor: {
      title: '2 段階認証',
      enabled: '有効',
      disabled: '無効',
      enable: '2FA を有効にする',
      disable: '無効にする',
      setupInstruction: '認証アプリで QR コードを読み取り、表示された 6 桁を入力してください。',
      manualSecret: 'QR コードを読み取れない場合は、このシークレットを手入力してください。',
      codeLabel: '認証コード（6 桁）',
      verify: '有効化',
      recoveryCodesTitle: 'リカバリーコード',
      recoveryCodesWarning: 'このコードは 1 度しか表示されません。安全な場所に保存してください。',
      recoveryCodesRemaining: '残り {count} 件',
      recoveryCodesLow: 'リカバリーコードの残りが少なくなっています。再生成してください。',
      regenerate: 'リカバリーコードを再生成',
      savedConfirm: '安全な場所に保存しました',
      copy: 'コピー',
      download: 'ダウンロード',
      print: '印刷',
      close: '閉じる',
      useRecoveryCode: 'リカバリーコードを使う',
      useTotpCode: '認証アプリのコードを使う',
      challengeTitle: '2 段階認証',
      challengeInstruction: '認証アプリに表示された 6 桁のコードを入力してください。',
      challengeBack: '別のアカウントでログイン',
      strongReauthTitle: '本人確認',
      strongReauthInstruction: '無効化・再生成には、パスワードと現在のコードが必要です。',
      strongReauthPassword: 'パスワード',
      strongReauthCode: '現在のコード（6 桁またはリカバリーコード）',
      strongReauthSubmit: '実行する',
      emailNotVerifiedTitle: 'メールアドレスの確認が必要です',
      emailNotVerifiedBody: '{email} に確認メールを送信しました。メール内のリンクから登録を完了してください。',
      emailNotVerifiedResend: '確認メールを再送する',
      emailNotVerifiedBack: '別のアカウントでログイン',
    },
    passkey: {
      title: 'Passkey',
      count: '{count} 件',
      none: 'Passkey はまだ登録されていません。',
      add: 'Passkey を追加',
      addHint: '端末の生体認証やセキュリティキーでログインできます。',
      remove: '削除',
      removeConfirm: 'この Passkey を削除しますか？',
      lastMethod: '最後のログイン手段のため削除できません。先にパスワードまたは 2 段階認証を設定してください。',
      createdAt: '追加日時',
      lastUsedAt: '最終使用',
      neverUsed: '未使用',
      synced: '同期',
      deviceNameLabel: 'デバイス名（任意）',
      deviceNamePlaceholder: '例: MacBook の Touch ID',
      registerFailed: 'Passkey を登録できませんでした。',
      registerReauthHint: 'Passkey の登録には本人確認が必要です。パスワードを入力してください。',
      loginFailed: 'パスキーでログインできませんでした。別の方法をお試しください。',
      loginButton: 'パスキーでログイン',
      notSupported: 'この端末・ブラウザは Passkey に対応していません。',
      reauthTabPasskey: 'Passkey で確認',
    },
    sessions: {
      title: 'ログイン中のデバイス',
      currentBadge: '現在のセッション',
      osLabel: 'OS',
      lastSeen: '最終アクセス',
      createdAt: 'ログイン日時',
      signOut: 'ログアウト',
      signOutAll: 'すべてのデバイスからログアウト',
      signOutAllConfirm: 'すべてのデバイスからログアウトしますか？',
      signOutAllDescription: 'すべてのデバイスでログインし直しが必要になります。',
      signOutAllResult: 'すべてのデバイスからログアウトしました',
      signOutResult: 'ログアウトしました',
      emptyOthers: '他のデバイスはありません',
      notFound: 'セッションが見つかりません。ログインし直してください。',
      currentSelfSignOut: '現在のデバイスからログアウトします',
    },
    security: {
      title: 'セキュリティ',
      passwordChangedAt: '最終変更',
      email: 'メールアドレス',
      emailVerified: '認証済み',
      emailUnverified: '未確認',
      emailResend: '確認メールを再送',
      twoFactor: '2 段階認証',
      disabled: '無効',
      linkedAccounts: '連携アカウント',
      notLinked: '未連携',
      oidcClients: 'OIDC / OAuth 2.0 クライアント',
      oidcClientsHint: '自作サービス向けのクライアントを管理します。',
      devices: 'ログイン中のデバイス',
      viewAllDevices: 'すべてのセッションを見る',
      recentEvents: '最近のセキュリティイベント',
      recentEventsHint: '直近{n}件を表示しています。この一覧は読み取り専用です。',
      changePassword: 'パスワードを変更',
      noEvents: 'セキュリティイベントはまだありません。',
      eventLabels: {
        register: 'アカウント登録',
        login_success: '新しいログイン',
        login_failed: 'ログインに失敗',
        logout: 'ログアウト',
        password_changed: 'パスワードを変更',
        password_reset: 'パスワードをリセット',
        email_changed: 'メールアドレスを変更',
        email_verified: 'メールアドレスを確認',
        session_revoked: 'セッションを無効化',
        account_deleted: 'アカウントを削除',
        account_suspended: 'アカウントを停止',
        account_unsuspended: 'アカウントの停止を解除',
        role_changed: '権限を変更',
        new_device_login: '新しいデバイスからログイン',
        rate_limited: 'リクエスト制限',
        breach_check_fail_open: '漏洩パスワード検査をスキップ',
        security_notification_failed: '通知メールの送信に失敗',
        email_change_notification_failed: '変更通知の送信に失敗',
      } as Record<string, string>,
    },
    auth: {
      loginRequired: 'ログインが必要です',
      loginTitle: 'ログイン',
      registerTitle: 'アカウント登録',
      username: 'ユーザー名',
      email: 'メールアドレス',
      identifierLabel: 'メールアドレスまたはユーザー名',
      passwordLabel: 'パスワード',
      confirmPasswordLabel: 'パスワード（確認）',
      submitLogin: 'ログイン',
      submitRegister: '登録する',
      forgotLink: 'パスワードをお忘れですか？',
      noAccountPrompt: 'アカウントをお持ちでないですか？',
      hasAccountPrompt: 'すでにアカウントをお持ちですか？',
      resetTitle: '新しいパスワード',
      resetDescription: '新しいパスワードを入力してください。変更すると他のデバイスからはログアウトされます。',
      resetAction: 'パスワードを変更する',
      resetDone: 'パスワードを変更しました。他のデバイスからもログアウトされました。',
      confirmPassword: '新しいパスワード（確認）',
      verifyTitle: 'メールアドレスの確認',
      verifyDescription: '登録を完了するには下のボタンを押してください。',
      verifyAction: 'メールアドレスを確認する',
      verifyDone: 'メールアドレスを確認しました。ログインできます。',
      verifyFailed: '確認できませんでした。リンクが無効か、有効期限が切れている可能性があります。',
      resendAction: '確認メールを再送',
      resendSent: '確認メールを送信しました。メールに記載されたリンクから登録を完了してください。',
      resendFailed: '再送信できませんでした。時間をおいて再度お試しください。',
      resendTooMany: '再送信できる回数を超過しました。時間をおいて再度お試しください。',
      forgotTitle: 'パスワードの再設定',
      forgotDescription: '登録したメールアドレスを入力してください。再設定用のリンクをお送りします。',
      forgotAction: '再設定メールを送信',
      forgotSent: '登録メールアドレスなら再設定メールを送信しました。',
      logout: 'ログアウト',
      emailChangeTitle: 'メールアドレスの変更確認',
      emailChangeDescription: '新しいメールアドレスの確認を完了するには、下のボタンを押してください。',
      emailChangeAction: 'メールアドレス変更を確定する',
      emailChangeDone: 'メールアドレスを変更しました。新しいアドレスでログインできます。',
    },
    preferences: {
      timezone: 'タイムゾーン',
    },
    oauth: {
      title: '連携アカウント',
      description:
        '外部アカウントでログインできるようにします。連携すると、パスワードなしでそのアカウントを使って入れます。',
      securityNotice:
        '連携しても既存のパスワードはそのまま使えます。どちらの手段でもログインできます。',
      providerLabel: '{provider} で続行',
      linkAction: '連携する',
      unlinkAction: '連携を解除',
      unlinkConfirmTitle: '連携を解除しますか？',
      unlinkConfirmBody:
        'この連携を解除すると、{provider} でのログインが使えなくなります。別のログイン手段が残っていることを確認してください。',
      linkedAt: '連携日: {date}',
      lastUsedAt: '最終利用: {date}',
      providerEmail: '連携時のメールアドレス: {email}',
      neverUsed: '最終利用: まだ利用していません',
      empty: '連携中のアカウントはありません。',
      emptyHint: '下のボタンから外部アカウントを追加できます。',
      availableNone: '利用できる外部アカウントが設定されていません。',
      count: '連携中: {count} 件',
      viewAll: '連携を管理する',
      result: {
        linked: '連携しました',
        unlinked: '連携を解除しました',
      },
      confirm: {
        title: '{provider} の連携を確認',
        intro: '認証された情報を確認し、何をするかを選んでください。',
        emailLabel: '認証されたメールアドレス',
        emailUnverifiedNotice:
          'このメールアドレスは検証されていない、または公開されていません。そのため、このメールアドレスでアカウントを作ることはできません。',
        existingAccountNotice:
          'このメールアドレスは既に登録されています。パスワードを入力すると、そのアカウントにログインして {provider} を連携します。',
        newAccountNotice: 'このメールアドレスはまだ使われていません。アカウントを作成できます。',
        passwordNotice: '入力したメールアドレスとパスワードが一致すると、ログインして {provider} を連携します。',
        identifierLabel: 'メールアドレス',
        passwordLabel: 'パスワード',
        signupAction: 'このメールアドレスでアカウントを作る',
        passwordAction: 'このメールアドレスでログインして連携',
        loginElsewhereAction: '別のアカウントでログインする',
        ownerOnlyNotice:
          '入力するメールアドレスは、上に表示されたものと同じである必要があります。別のアカウントにログインしたい場合は、ログイン画面からログインしてから設定画面で連携してください。',
        submitting: '処理中…',
        cancel: '連携しない（ログイン画面へ）',
        error: {
          invalidState: '確認の有効期限が切れました。もう一度ログインし直してください。',
          invalidCredentials: 'メールアドレスまたはパスワードが正しくありません。',
          emailConflict: 'このメールアドレスは既に登録済みです。パスワードでログインして連携してください。',
          linkedElsewhere: 'この認証情報は既に別のアカウントで使われています。',
          notLinkable: 'この認証情報ではアカウントを作成できません。',
          ownerMismatch:
            'この認証情報は、上に表示されたメールアドレスのアカウントにだけ連携できます。別のアカウントを使う場合は、ログイン画面からログインしてください。',
          rateLimited: '試行回数が多すぎます。しばらくしてからお試しください。',
          internal: '処理に失敗しました。もう一度お試しください。',
        },
      },
      errors: {
        cancelled: '認証をキャンセルしました。もう一度お試しください。',
        account_not_linkable:
          'このアカウントはメールアドレスが未確認、または公開されていないため、当サービスでは利用できません。',
        already_linked: 'このプロバイダーは既に連携されています。',
        already_linked_elsewhere: 'この認証情報は既に別のアカウントで使われています。',
        email_conflict: 'このメールアドレスは別のアカウントに登録済みです。',
      },
    },
    applications: {
      listTitle: 'アプリケーション',
      createTitle: '新しいアプリを作成',
      detailTitle: 'アプリの設定',
      clientTypeImmutable: '種別（作成後は変更できません）',
      scopeHint: 'scope を広げても既存の同意は変わりません。新 scope は再同意時に付与されます。',
      secretShownOnce: 'client secret はこの 1 回だけ表示されます。保存後は再表示できません。',
      rotateSecret: 'client secret の再生成',
      revoke: '利用を停止する',
      test: '接続テスト',
      testRedirectUriHint: '接続テストには次の URI をリダイレクト URI へ手動追加してください。',
      testRedirectUriMissing: 'テスト用 URI がリダイレクト URI に登録されていません。追加して保存してください。',
      secretRequiredForTest: 'client secret を入力してください（このテストのためだけに送信します）。',
    },
  },
} as const;

/** エラーコードの既定メッセージ（`errors` 配下）。UI 文言と同じ 1 か所で管理する（D-30-18）。 */
export type ErrorMessagePath = MessagePath<Messages['errors']>;

export function errorMessage(path: ErrorMessagePath): string {
  return resolveMessage(messages.errors, path);
}

/** メッセージはここだけから引く（計画 14 章 / D-30-18）。 */
export type Messages = typeof messages;

/** `ui` 配下の文字列へのドット区切りパス（例: `theme.darkHint`）。 */
type MessagePath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : MessagePath<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type UiMessagePath = MessagePath<Messages['ui']>;

function resolveMessage(source: unknown, path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key], source);
  if (typeof value !== 'string') {
    throw new Error(`Unknown message key: ${path}`);
  }
  return value;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

/**
 * `m('theme.currentResolved', { value: 'ダーク' })` のように参照する。
 * 存在しないキーは型で弾かれる（ミスペルの検出）。
 */
export function m(path: UiMessagePath, vars: Record<string, string | number> = {}): string {
  return interpolate(resolveMessage(messages.ui, path), vars);
}
