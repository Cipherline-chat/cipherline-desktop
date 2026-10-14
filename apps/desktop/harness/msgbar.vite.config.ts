// Message action-bar placement harness: renders the REAL MsgActionBar/MsgBarBtn + index.css in mock rows.
//   npx vite --config harness/msgbar.vite.config.ts   then: node harness/msgbar-shots.mjs
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-msgbar-vite-cache'),
  plugins: [react()],
  base: './',
  build: {
    outDir: process.env.MSGBAR_OUT ?? path.join(os.tmpdir(), 'cipherline-msgbar-dist'),
    emptyOutDir: true,
    rollupOptions: { input: [path.resolve(__dirname, 'msgbar.html')] },
  },
  server: { host: '127.0.0.1', port: 5291, strictPort: true, open: false },
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
