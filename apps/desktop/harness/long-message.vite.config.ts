// Long-message collapse harness (harness/long-message-main.tsx, driven by harness/long-message-shots.mjs):
// the REAL LongMessageBody + reader + ChatPane's own renderTextWithMentions, in mock rows that mirror ChatPane's markup.
//   npx vite --config harness/long-message.vite.config.ts      (serves :5331)
//   node harness/long-message-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.LM_CACHE ?? path.join(os.tmpdir(), 'vite-long-message-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.LM_PORT ?? 5331), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: {
    'mammoth': 'mammoth/mammoth.browser.min.js',
    'exceljs': 'exceljs/dist/exceljs.min.js',
    '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts'),
  } },
})
