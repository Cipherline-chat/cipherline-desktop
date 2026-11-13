// Device-sync "Send history" button harness (harness/device-sync-main.tsx).
//   npx vite --config harness/device-sync.vite.config.ts   (serves :5291)
//   node harness/device-sync-shots.mjs                      (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// REAL: HistoryRequestModal (the approver's "Send history" dialog), ClButton/ClModal and the kit CSS.
// FAKE: useAuth, the C-2b advertisement check + key wrap, exportLocalHistory (held open by the
// harness so the loading state can be photographed) and the network (axios adapter in main).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'device-sync-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: process.env.DS_CACHE ?? path.join(os.tmpdir(), 'vite-device-sync'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.DS_PORT ?? 5291), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/historyRequestProof$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/historyTransferKey$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/crypto$/, replacement: stubs },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
