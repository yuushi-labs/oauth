import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import security from 'eslint-plugin-security';

const baseDirectory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

const eslintConfig = [
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'],
  },
  {
    // 未使用の eslint-disable コメントを警告しない（ディレクティブの保守は別途）。
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts'],
    plugins: { security },
    rules: {
      'security/detect-eval-with-expression': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-child-process': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-unsafe-regex': 'warn',
      'security/detect-invisible-characters': 'warn',
      // 以下は eslint-plugin-security のヒューリスティックで、本コードベースでは
      // 誤検知のみ（process.env[key]・messages のドット参照・テストの動的パス等）。
      // ノイズになるため無効化する。
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-regexp': 'off',
      'security/detect-object-injection': 'off',
      // 未使用 import / 変数の検出は無効化（必要な箇所はレビューで担保）。
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
];

export default eslintConfig;