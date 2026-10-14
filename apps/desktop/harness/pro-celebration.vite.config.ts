import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// "You're Pro" celebration harness (harness/pro-celebration-main.tsx, shots: pro-celebration-shots.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.PRO_CEL_CACHE ?? path.join(os.tmpdir(), 'vite-pro-celebration'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PRO_CEL_PORT ?? 5233), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
