// "Everyday touches" harness: the small features (loading tips, typing line, reaction burst, shortcuts
// sheet, What's new, Back online, title-bar lap) in real Chromium.
//   npx vite --config harness/everyday.vite.config.ts      (serves :5431; EVERYDAY_PORT overrides)
//   node harness/everyday-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
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
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.EVERYDAY_CACHE ?? path.join(os.tmpdir(), 'cipherline-everyday-vite-cache'),
  plugins: [whatsNewPlugin(), react()],
  // scan only this page (the default scans every harness and the app, which the call harness's stub cannot satisfy)
  optimizeDeps: { entries: ['harness/everyday.html'] },
  server: { host: '127.0.0.1', port: Number(process.env.EVERYDAY_PORT ?? 5431), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
