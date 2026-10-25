// Dialogs wave 1 harness: renders the REAL dialogs of the wave-1 batch (and the foundation
// ClModal/ClConfirm) over an app-like backdrop, against a stubbed network / auth / avatar decrypt.
//   npx vite --config harness/dialogs-wave1.vite.config.ts    (serves :5312)
//   node harness/dialogs-wave1-shots.mjs                      (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-dialogs-wave1-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5312, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    // useAuth() needs no provider in the harness.
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'new-message-auth-stub.ts') },
    // Avatars resolve instantly to inline pictures — no network, no decrypt.
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'new-message-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
