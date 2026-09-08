import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default typescriptEslint.config(
  // `scripts/` is deliberately NOT ignored: it holds the code that decides
  // whether a release ships working engines (download-binaries, check-binaries,
  // verify-engine, build). It went unlinted for a long time, which is part of
  // how download-plugins.ts drifted out of step with the layout it writes to.
  { ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'release/**', 'binaries/**', 'plugins/**', 'plugins-win/**', 'coverage/**', 'playwright-report/**', 'test-results/**', '*.config.*', '*.lock'] },
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: '18.3' },
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  }
);