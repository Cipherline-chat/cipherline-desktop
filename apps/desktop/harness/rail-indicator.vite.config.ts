import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Rail indicator first-open stall harness (harness/rail-indicator-main.tsx, strips by
// harness/rail-indicator-shots.mjs):
//   npx vite --config harness/rail-indicator.vite.config.ts   (serves :5332, RI_PORT to change)
//   node harness/rail-indicator-shots.mjs <outDir>
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.RI_CACHE ?? path.join(os.tmpdir(), 'vite-rail-indicator'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.RI_PORT ?? 5332), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
