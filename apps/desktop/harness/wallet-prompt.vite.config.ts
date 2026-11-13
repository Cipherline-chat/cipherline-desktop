// Linux wallet prompt harness (harness/wallet-prompt-main.tsx): the REAL StorageLockedScreen / WalletLockedView /
// KeyringWalletBanner + the app CSS, with window.electronAPI stubbed.
//   npx vite --config harness/wallet-prompt.vite.config.ts   (serves :5312)
//   node harness/wallet-prompt-shots.mjs                     (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stub = path.resolve(__dirname, 'banners-stubs.tsx')
export default defineConfig({
  root: app,
  cacheDir: process.env.WP_CACHE ?? path.join(os.tmpdir(), 'vite-wallet-prompt-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.WP_PORT ?? 5312), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: stub },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
