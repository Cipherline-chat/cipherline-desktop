// Member-roster bench: renders the REAL ServerContextPanel against a stubbed
// network so "open a server -> member rows painted" can be timed in a browser.
//   npx vite --config harness/roster.vite.config.ts      (then drive it with a CDP/Playwright script)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-roster-bench-vite-cache'),
  plugins: [react()],
  // `vite build --config harness/roster.vite.config.ts` -> a PRODUCTION bundle (no
  // jsxDEV / dev-mode React), which is what the timings should be taken from.
  base: './',
  build: {
    outDir: process.env.ROSTER_BENCH_OUT ?? path.join(os.tmpdir(), 'cipherline-roster-bench-dist'),
    emptyOutDir: true,
    rollupOptions: { input: [path.resolve(__dirname, 'roster.html'), path.resolve(__dirname, 'channel-switch.html')] },
  },
  server: { host: '127.0.0.1', port: 5287, strictPort: true, open: false },
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
