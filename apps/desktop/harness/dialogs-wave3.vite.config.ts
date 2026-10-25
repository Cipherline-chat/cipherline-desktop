// Wave-3 dialogs harness: renders the REAL components over an app-like backdrop against stubbed
// network / contexts / history-transfer key checks / electronAPI. Never loads Stripe.
//   npx vite --config harness/dialogs-wave3.vite.config.ts      (serves :5327)
//   node harness/dialogs-wave3-shots.mjs                        (env: OUT=<dir> LABEL=before|after ...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'dialogs-wave3-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-dialogs-wave3-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5327, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/ToastContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/historyRequestProof$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/historyTransferKey$/, replacement: stubs },
    { find: /^(\.\.?\/)+(utils\/)?secureLocalStore$/, replacement: stubs },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
