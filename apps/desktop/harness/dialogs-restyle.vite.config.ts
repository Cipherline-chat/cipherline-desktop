// Dialogs-restyle harness: renders the REAL block-user / report / password-confirm / prompt dialogs over an
// app-like backdrop against stubbed network / contexts / avatar decrypt.
//   npx vite --config harness/dialogs-restyle.vite.config.ts      (serves :5341; PORT=... to move it)
//   node harness/dialogs-restyle-shots.mjs                        (env: OUT=<dir> LABEL=before|after V=old|new ...)
// "before" shots come from a checkout of the parent commit: v=old renders verbatim copies of the removed inline
// dialogs (dialogs-restyle-legacy.tsx) next to the components that still existed there.
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
  cacheDir: path.join(os.tmpdir(), `cipherline-dialogs-restyle-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5341), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/ToastContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+(utils\/)?secureLocalStore$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'dialogs-restyle-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
