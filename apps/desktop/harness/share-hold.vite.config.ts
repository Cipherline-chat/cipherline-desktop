// Share republish hold, end to end: two real clients on a throwaway LiveKit container.
// See share-hold-run.mjs for how to run it. Serves :5497 (PORT overrides).
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
  cacheDir: path.join(os.tmpdir(), `cipherline-share-hold-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5497), strictPort: true, open: false },
  optimizeDeps: { entries: ['harness/share-hold.html'] },
  worker: { format: 'es' },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: path.resolve(__dirname, 'share-hold-store-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
