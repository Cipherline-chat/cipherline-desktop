// Channel/category settings modal harness: renders the REAL ChannelSettingsDialog / CategoryFormDialog
// with a stubbed network (axios adapter) so the small-window layout can be measured + screenshotted.
//   npx vite --config harness/channel-modal-scroll.vite.config.ts      (serves :5299)
//   node harness/channel-modal-scroll-shots.mjs                        (env: OUT=<dir> CDP=http://127.0.0.1:9510)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-channel-modal-scroll-vite-cache'),
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5299, strictPort: true, open: false },
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
