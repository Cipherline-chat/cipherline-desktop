// PurgeDropdown harness: renders the REAL StorageSettings (Conversation storage card) + the app stylesheets.
//   npx vite --config harness/purge-menu.vite.config.ts   then: node harness/purge-menu-shots.mjs
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-purge-menu-vite-cache'),
  plugins: [react()],
  base: './',
  build: {
    outDir: process.env.PURGE_MENU_OUT ?? path.join(os.tmpdir(), 'cipherline-purge-menu-dist'),
    emptyOutDir: true,
    rollupOptions: { input: [path.resolve(__dirname, 'purge-menu.html')] },
  },
  server: { host: '127.0.0.1', port: 5297, strictPort: true, open: false },
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
