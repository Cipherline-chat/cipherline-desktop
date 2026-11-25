// Link-shortening harness (harness/link-shorten-main.tsx, driven by harness/link-shorten-shots.mjs):
// the REAL FormattedText + ChatPane's renderTextWithMentions in rows that mirror ChatPane's markup.
//   npx vite --config harness/link-shorten.vite.config.ts      (serves :5352)
//   node harness/link-shorten-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.LS_CACHE ?? path.join(os.tmpdir(), 'vite-link-shorten-harness'),
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: Number(process.env.LS_PORT ?? 5352), strictPort: true, open: false },
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
