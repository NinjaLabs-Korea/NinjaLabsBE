// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Raw pg rows are typed per query; the generic `QueryResultRow` fallback is intentional.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // NestJS decorators and DTO classes rely on `!` definite assignment.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
