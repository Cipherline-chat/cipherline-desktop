// Store-unread recovery harness (harness/store-unread-main.tsx): the REAL StorageReadFailedScreen,
// StorageOpeningScreen and ShrinkBackupModal + the app CSS and theme stylesheets, with
// window.electronAPI stubbed (relaunchApp is counted, never relaunches anything).
//   npx vite --config harness/store-unread.vite.config.ts   (serves :5331)
//   node harness/store-unread-shots.mjs                     (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.SU_CACHE ?? path.join(os.tmpdir(), 'vite-store-unread-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.SU_PORT ?? 5331), strictPort: true, open: false },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
