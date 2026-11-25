// Link-embeds harness (harness/link-embeds-main.tsx, driven by
// harness/link-embeds-electron.mjs inside the REAL Electron main + preload,
// so clmedia://, the IPC and the CSP are the shipped ones).
//   LE_PORT=5463 npx vite --config harness/link-embeds.vite.config.ts
// AuthContext / SubscriptionContext are the window-sizes stubs. No API.
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
  cacheDir: process.env.LE_CACHE ?? path.join(os.tmpdir(), 'vite-link-embeds'),
  // virtual:whats-new: the real app at "/" (the first page the window loads) imports it.
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: Number(process.env.LE_PORT ?? 5463), strictPort: true, open: false, hmr: { overlay: false } },
  resolve: { alias: [
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
