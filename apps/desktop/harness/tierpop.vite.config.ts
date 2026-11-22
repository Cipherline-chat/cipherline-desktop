// Storage tier popover inside a scrolling settings pane (the REAL ServerStoragePanel, axios stubbed).
//   npx vite --config harness/tierpop.vite.config.ts   (serves :5341)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'vite-tierpop-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5341, strictPort: true, open: false },
  resolve: { alias: [
    { find: /^axios$/, replacement: path.resolve(__dirname, 'tierpop-axios-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
