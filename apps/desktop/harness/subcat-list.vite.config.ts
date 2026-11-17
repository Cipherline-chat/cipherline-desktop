import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Sub-categories + dividers harness (harness/subcat-list-main.tsx, shot by
// harness/subcat-list-shots.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.SCL_CACHE ?? path.join(os.tmpdir(), 'vite-subcat-list'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.SCL_PORT ?? 5231), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
