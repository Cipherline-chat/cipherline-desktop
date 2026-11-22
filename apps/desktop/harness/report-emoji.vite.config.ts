// Report dialog with custom emoji in the reported message (the REAL ReportModal + ReportEmojiPreview).
//   npx vite --config harness/report-emoji.vite.config.ts      (serves :5341)
//   node harness/report-emoji-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// Only the server-emoji IMAGE component is stubbed (the real one decrypts through the API).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'vite-report-emoji-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5341, strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: path.resolve(__dirname, 'report-emoji-store-stub.ts') },
    { find: /^\.\.\/secureLocalStore$/, replacement: path.resolve(__dirname, 'report-emoji-store-stub.ts') },
    { find: /^\.\/secureLocalStore$/, replacement: path.resolve(__dirname, 'report-emoji-store-stub.ts') },
    { find: /^\.\/server\/EmojiImage$/, replacement: path.resolve(__dirname, 'report-emoji-image-stub.tsx') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
