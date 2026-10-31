import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly', Buffer: 'readonly',
};

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.runtime/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: nodeGlobals },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
