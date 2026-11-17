// Text-formatting harness (harness/text-formatting-main.tsx, driven by harness/text-formatting-shots.mjs):
// the REAL FormattedText + ChatPane's renderTextWithMentions in rows that mirror ChatPane's markup, and the REAL
// FormatToolbar + MarkdownPastePrompt in a pill that mirrors the composer, wired with the same pure edit functions.
//   npx vite --config harness/text-formatting.vite.config.ts      (serves :5341)
//   node harness/text-formatting-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.TF_CACHE ?? path.join(os.tmpdir(), 'vite-text-formatting-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.TF_PORT ?? 5341), strictPort: true, open: false },
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
