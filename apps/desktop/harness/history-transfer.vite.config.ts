// The sign-in history step and the own-device transfer screens (the REAL components) over an app-like backdrop.
//   npx vite --config harness/history-transfer.vite.config.ts      (serves :5341)
//   node harness/history-transfer-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'history-transfer-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'vite-history-transfer-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5341, strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useOwnDevicePresence$/, replacement: stubs },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
