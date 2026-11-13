import { defineConfig } from 'vite'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// The Firewall worker on a bare canvas (harness/firewall-rate-main.ts), measured by firewall-rate.mjs.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.FW_RATE_CACHE ?? path.join(os.tmpdir(), 'vite-firewall-rate'),
  server: { host: '127.0.0.1', port: Number(process.env.FW_RATE_PORT ?? 5244), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
