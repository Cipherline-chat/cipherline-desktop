// Lock screen during boot harness (harness/lockscreen-boot-main.tsx, driven by lockscreen-boot-shots.mjs).
//   npx vite --config harness/lockscreen-boot.vite.config.ts   (serves :5231)
// REAL: useScreenLock, ScreenLockOverlay, LockScreenField, AppLoadingScreen, HydrationGate, the worker host
// and the worker. Stubbed: only AuthContext (the overlay uses it for logout()).
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
  cacheDir: process.env.LOCKBOOT_CACHE ?? path.join(os.tmpdir(), 'vite-lockscreen-boot'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.LOCKBOOT_PORT ?? 5231), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'lockscreen-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
