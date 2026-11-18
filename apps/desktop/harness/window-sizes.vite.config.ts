// Window-size layout harness (harness/window-sizes-main.tsx, checked by
// harness/window-sizes-check.mjs). The REAL components of the 2026-11-17 round
// placed in a Dashboard-shaped frame whose pane widths follow Dashboard's own
// rules, so the chat column is as narrow as it really gets at each window size.
//   WS_PORT=5391 npx vite --config harness/window-sizes.vite.config.ts
// AuthContext / SubscriptionContext and Stripe's React bindings are stubbed
// (harness/window-sizes-stubs.ts, harness/window-sizes-stripe-stub.tsx); every
// API call is answered in-page by an axios adapter. No network but web fonts.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.WS_CACHE ?? path.join(os.tmpdir(), 'vite-window-sizes'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.WS_PORT ?? 5391), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^@stripe\/react-stripe-js$/, replacement: path.resolve(__dirname, 'window-sizes-stripe-stub.tsx') },
    { find: /^@stripe\/stripe-js\/pure$/, replacement: path.resolve(__dirname, 'window-sizes-stripe-stub.tsx') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
