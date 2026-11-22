import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Channel mute harness (harness/channel-mute-main.tsx, shot by
// harness/channel-mute-shots.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.CMU_CACHE ?? path.join(os.tmpdir(), 'vite-channel-mute'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.CMU_PORT ?? 5241), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
