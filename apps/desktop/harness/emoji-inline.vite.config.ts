// Inline-emoji clip harness (harness/emoji-inline-main.tsx, driven by harness/emoji-inline-check.mjs):
// emoji beside text in every message-body shape ChatPane draws (plain, formatted, card, reply, sizes,
// long-message collapse, jumbo) plus the composer, measured against every clipping ancestor.
//   npx vite --config harness/emoji-inline.vite.config.ts      (serves :5361)
//   node harness/emoji-inline-check.mjs                       (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.EI_CACHE ?? path.join(os.tmpdir(), 'vite-emoji-inline-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.EI_PORT ?? 5361), strictPort: true, open: false },
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
