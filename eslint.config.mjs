import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import orchestra from './tools/eslint-rules/index.mjs';

const typedFiles = ['apps/**/*.ts', 'packages/**/*.ts', 'vitest.config.ts'];
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.turbo/**', 'plan/**', '.claude/**'] },
  js.configs.recommended,
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: globals.node } },
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        project: ['./apps/*/tsconfig.lint.json', './packages/*/tsconfig.lint.json', './packages/providers/*/tsconfig.lint.json', './tsconfig.tools.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'simple-import-sort': simpleImportSort, orchestra },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  prettier,
);
