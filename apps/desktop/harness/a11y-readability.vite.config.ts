// Accessibility readability harness (harness/a11y-readability-main.tsx, shots: harness/a11y-readability-shots.mjs).
// The REAL ChatPane and Accessibility pane with A11yRuntime mounted.
//   A11Y_PORT=5447 npx vite --config harness/a11y-readability.vite.config.ts
// AuthContext / SubscriptionContext are the window-sizes stubs; every API call is answered in-page.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.A11Y_CACHE ?? path.join(os.tmpdir(), 'vite-a11y-readability'),
  // virtual:whats-new (src/utils/whatsNew.ts) is served by the app's own plugin.
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.A11Y_PORT ?? 5447), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+(contexts\/)?AuthContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+(contexts\/)?SubscriptionContext$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^mammoth$/, replacement: 'mammoth/mammoth.browser.min.js' },
    { find: /^exceljs$/, replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
