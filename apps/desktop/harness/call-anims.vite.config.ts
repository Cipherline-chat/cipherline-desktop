// Call join / leave animation harness: the real presence layer + row / tile shells
// with stubbed auth / avatar decrypt (no network).
//   npx vite --config harness/call-anims.vite.config.ts      (serves :5361)
//   OUT=<dir> node harness/call-anims-shots.mjs
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
  cacheDir: path.join(os.tmpdir(), `cipherline-call-anims-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5361), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
