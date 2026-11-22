// Discord HISTORY import, real-API harness (harness/discord-history-main.tsx, shots: harness/discord-history-shots.mjs).
// The REAL wizard + history runner + ChatPane + Pins panel over a MOCK Discord, talking to an ISOLATED local API
// (never the shared dev stack, staging or prod). VITE_API_HOST is pinned to the loopback API here, at build time, so
// the very first request already goes there; the page refuses to start if API_BASE is anything else.
//   HISTORY_API_HOST=127.0.0.1:13105 PORT=5353 npx vite --config harness/discord-history.vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const apiHost = process.env.HISTORY_API_HOST ?? '127.0.0.1:13105'
if (!/^127\.0\.0\.1:\d+$/.test(apiHost)) throw new Error(`discord-history harness: refusing a non-loopback API host ${apiHost}`)
const stubs = path.resolve(__dirname, 'discord-history-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), `cipherline-discord-history-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5353), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_API_HOST': JSON.stringify(apiHost),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: stubs },
    { find: /^mammoth$/, replacement: 'mammoth/mammoth.browser.min.js' },
    { find: /^exceljs$/, replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
