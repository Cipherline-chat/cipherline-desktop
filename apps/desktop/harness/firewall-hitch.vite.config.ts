import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// The Firewall worker framed like the shell overlay, over a loadable main thread (harness/firewall-hitch-main.ts; firewall-hitch-home-main.tsx: the real Home behind the real overlay), measured by firewall-hitch.mjs.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  plugins: [react()],
  cacheDir: process.env.FW_HITCH_CACHE ?? path.join(os.tmpdir(), 'vite-firewall-hitch'),
  server: { host: '127.0.0.1', port: Number(process.env.FW_HITCH_PORT ?? 5246), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
