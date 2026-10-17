import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** ユーティリティクラスの結合（重複プロパティは後勝ちで潰す）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}