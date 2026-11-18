// Gift Pro harness (harness/gifts-main.tsx, shots: gifts-shots.mjs).
//   npx vite --config harness/gifts.vite.config.ts      (serves :5617)
//   node harness/gifts-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
// AuthContext / SubscriptionContext are swapped for harness/gifts-stubs.ts; every
// API call is answered in-page by a mock axios adapter (gifts-main.tsx), so the
// page never touches the API (only the brand web fonts load from the network).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// ProWelcome (the ?welcome=1 layer) reaches utils/whatsNew through its imports.
import { whatsNewPlugin } from '../vite-plugin-whats-new'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.GIFTS_CACHE ?? path.join(os.tmpdir(), 'cipherline-gifts-vite-cache'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.GIFTS_PORT ?? 5617), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'gifts-stubs.ts') },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: path.resolve(__dirname, 'gifts-stubs.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
