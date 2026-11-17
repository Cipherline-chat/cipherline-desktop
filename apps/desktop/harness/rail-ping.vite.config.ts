import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Rail off-screen ping arrows harness (harness/rail-ping-main.tsx, shots by
// harness/rail-ping-shots.mjs):
//   npx vite --config harness/rail-ping.vite.config.ts   (serves :5331, RP_PORT to change)
//   node harness/rail-ping-shots.mjs <outDir>
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.RP_CACHE ?? path.join(os.tmpdir(), 'vite-rail-ping'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.RP_PORT ?? 5331), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
