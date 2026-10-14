// Screen Lock → "hide message previews?" suggestion harness (harness/lock-preview-suggest-main.tsx).
//   npx vite --config harness/lock-preview-suggest.vite.config.ts   (serves :5233)
//   node harness/lock-preview-suggest-shots.mjs                     (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// REAL: ScreenLockSettings, useScreenLock, NotificationProvider/prefs, NotificationsTab's preview select
// (read back via the same context). Stubbed: only AuthContext (userId + logout).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.LPS_CACHE ?? path.join(os.tmpdir(), 'vite-lock-preview-suggest'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.LPS_PORT ?? 5233), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    // '../contexts/AuthContext' from components/hooks AND './AuthContext' from sibling contexts
    { find: /^(((\.\.?\/)+contexts\/)|(\.\/))AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'lock-preview-suggest-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
