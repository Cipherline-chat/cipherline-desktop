import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Off-screen unread pill harness (harness/offscreen-unread-main.tsx, driven by
// harness/offscreen-unread-drive.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.OUP_CACHE ?? path.join(os.tmpdir(), 'vite-offscreen-unread'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.OUP_PORT ?? 5218), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
