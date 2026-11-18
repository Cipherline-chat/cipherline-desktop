import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Collapsible member-list groups harness (harness/member-groups-main.tsx, shot by
// harness/member-groups-shots.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.MG_CACHE ?? path.join(os.tmpdir(), 'vite-member-groups'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.MG_PORT ?? 5237), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
