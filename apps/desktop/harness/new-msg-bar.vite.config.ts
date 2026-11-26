// "Scrolled up, something new arrives" harness (harness/new-msg-bar-main.tsx, driven by
// harness/new-msg-bar-check.mjs). The REAL ChatPane in a Dashboard-shaped frame, a server
// channel, and in-page hooks that land messages / member rows / edits / reactions / images.
//   NMB_PORT=5452 npx vite --config harness/new-msg-bar.vite.config.ts
//   node harness/new-msg-bar-check.mjs --out=<dir>
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
  cacheDir: process.env.NMB_CACHE ?? path.join(os.tmpdir(), 'vite-new-msg-bar'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.NMB_PORT ?? 5452), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^mammoth$/, replacement: 'mammoth/mammoth.browser.min.js' },
    { find: /^exceljs$/, replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
