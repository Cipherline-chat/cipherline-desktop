// "Alone in call" dialog, its Voice & Video setting row and the capture-limited share hint (the REAL components).
//   npx vite --config harness/alone-notice.vite.config.ts      (serves :5322)
//   node harness/alone-notice-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'vite-alone-notice-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5322, strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: path.resolve(__dirname, 'alone-notice-store-stub.ts') },
    { find: /^\.\/secureLocalStore$/, replacement: path.resolve(__dirname, 'alone-notice-store-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
