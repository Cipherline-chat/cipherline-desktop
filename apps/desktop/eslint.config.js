import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 'dist-electron' is a local build artifact (gitignored, never committed) —
  // linting it hit a rule that doesn't exist in the current typescript-eslint
  // version, which is a hard config error, not a content one.
  globalIgnores(['dist', 'dist-electron', 'dist-ssr', 'harness/channel-keys/out']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v6+ ships a second family of rules driven by
      // the React Compiler's analysis (not the classic Rules of Hooks). This
      // app does not run the React Compiler, and the flagged patterns are
      // deliberate and pervasive here: syncing state from props/storage in an
      // effect, "latest value" refs written during render, wall-clock reads
      // in handlers. Rewriting them is a behaviour-changing refactor of the
      // call/websocket/media code, so they are reported as WARNINGS (still
      // visible in every lint run) rather than errors. The classic
      // rules-of-hooks stays an error and exhaustive-deps stays a warning.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/globals': 'warn',
      // Honour the conventional "deliberately unused" underscore prefix (and
      // rest-siblings used to omit a key) instead of forcing a rename or a
      // disable comment at each site. Un-prefixed unused names still error.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Test doubles and fixtures routinely stand in for wide third-party or
    // IPC shapes; typing them precisely adds noise without catching bugs.
    files: ['**/*.test.{ts,tsx}', 'vitest.setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
