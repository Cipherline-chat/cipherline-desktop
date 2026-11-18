// Save-without-a-jump harness (harness/save-no-jump-main.tsx, driven by harness/save-no-jump-check.mjs).
// The REAL ChatPane in a Dashboard-shaped frame, a server channel of formatted messages, and
// Save to server / Pin / Save for me wired to in-page state the way Dashboard wires them.
//   SNJ_PORT=5417 npx vite --config harness/save-no-jump.vite.config.ts
//   node harness/save-no-jump-check.mjs        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
// AuthContext / SubscriptionContext are the window-sizes stubs; every API call is answered in-page.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.SNJ_CACHE ?? path.join(os.tmpdir(), 'vite-save-no-jump'),
  // virtual:whats-new (src/utils/whatsNew.ts) is served by the app's own plugin.
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.SNJ_PORT ?? 5417), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    // ChatPane's rows, with a render counter (window.__snjRowRenders).
    { find: /^\.\/MemoRow$/, replacement: path.resolve(__dirname, 'save-no-jump-memorow.tsx') },
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^mammoth$/, replacement: 'mammoth/mammoth.browser.min.js' },
    { find: /^exceljs$/, replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
