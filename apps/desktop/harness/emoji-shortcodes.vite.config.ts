// Emoji shortcodes harness: the REAL ChatPane composer (derived from night-dive).
//   npx vite --config harness/emoji-shortcodes.vite.config.ts   (serves :5324)
//   node harness/emoji-shortcodes-shots.mjs
// Fakes: the network (axios adapter in -main), useAuth + avatar decrypt (aliases), window.electronAPI (partial).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.ES_CACHE ?? path.join(os.tmpdir(), 'vite-emoji-shortcodes'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.ES_PORT ?? 5324), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)*(contexts\/)?AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'settings-redesign-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'emoji-shortcodes-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
