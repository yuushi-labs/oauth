import { APP_NAME } from '@/config/app';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

export function emailButton(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  return `<p style="margin:28px 0;text-align:center"><a href="${safeUrl}" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#4f46e5;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(label)}</a></p><p style="margin:0;color:#64748b;font-size:13px;line-height:1.7">ボタンが開けない場合は、次のURLをブラウザにコピーしてください。<br><a href="${safeUrl}" style="color:#4f46e5;word-break:break-all">${safeUrl}</a></p>`;
}

export function emailLayout(title: string, content: string): string {
  const appName = escapeHtml(APP_NAME);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:32px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden"><tr><td style="padding:26px 32px;background:#312e81;color:#ffffff;font-size:20px;font-weight:700">${appName}</td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 18px;font-size:22px;line-height:1.4">${escapeHtml(title)}</h1><div style="font-size:15px;line-height:1.8;color:#334155">${content}</div></td></tr><tr><td style="padding:18px 32px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.7">このメールに心当たりがない場合は、何もせず削除してください。<br>© ${new Date().getFullYear()} ${appName}</td></tr></table></body></html>`;
}
