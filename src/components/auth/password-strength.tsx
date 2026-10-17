'use client';

import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/cn';
import { m } from '@/messages/ja';

/**
 * パスワード強度メーター（§42: 色＋アイコン＋テキスト）。
 * 強度の目安のみを持ち、**採否の正本はサーバ側**（validate/password.ts・strength.ts）にある。
 * 表示のみを担う。
 */
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export function scorePassword(value: string): StrengthLevel {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (value.length >= 16) score += 1;
  const classes = new Set([/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)));
  if (classes.size >= 2) score += 1;
  if (classes.size >= 3) score += 1;
  return Math.min(score, 4) as StrengthLevel;
}

const LEVELS: Record<StrengthLevel, { label: string; tone: string; Icon: typeof ShieldCheck }> = {
  0: { label: m('pwStrength.veryWeak'), tone: 'text-danger', Icon: ShieldAlert },
  1: { label: m('pwStrength.veryWeak'), tone: 'text-danger', Icon: ShieldAlert },
  2: { label: m('pwStrength.weak'), tone: 'text-danger', Icon: ShieldAlert },
  3: { label: m('pwStrength.fair'), tone: 'text-warning', Icon: ShieldQuestion },
  4: { label: m('pwStrength.good'), tone: 'text-success', Icon: ShieldCheck },
};

export function PasswordStrength({ value }: { value: string }) {
  const level = scorePassword(value);
  const { label, tone, Icon } = LEVELS[level];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2" role="progressbar" aria-valuenow={level} aria-valuemin={0} aria-valuemax={4} aria-valuetext={label}>
        <div className="h-1.5 flex-1 rounded-full bg-disabled-bg">
          <div className="h-1.5 rounded-full bg-primary transition-all" style={{ width: `${(level / 4) * 100}%` }} />
        </div>
        <Icon aria-hidden className={cn('size-4', tone)} />
        <span className={cn('text-xs font-medium', tone)}>{label}</span>
      </div>
      <p className="text-xs text-muted-fg">{m('pwStrength.guide')}</p>
      <p className="text-xs text-muted-fg">{m('pwStrength.reusedWarning')}</p>
    </div>
  );
}