// Composer WYSIWYG harness (harness/composer-wysiwyg-main.tsx, driven by harness/composer-wysiwyg-shots.mjs):
// the REAL RichComposer (WYSIWYG box) + FormatToolbar + MarkdownPastePrompt + SuggestionMenu in a pill that mirrors the
// composer, wired the way ChatPane wires them, and feed rows at Small / Normal / Large.
//   npx vite --config harness/composer-wysiwyg.vite.config.ts      (serves :5347)
//   node harness/composer-wysiwyg-shots.mjs                       (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.CW_CACHE ?? path.join(os.tmpdir(), 'vite-composer-wysiwyg-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.CW_PORT ?? 5347), strictPort: true, open: false },
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
