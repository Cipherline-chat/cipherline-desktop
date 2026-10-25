import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Keys on Home, interactive: the click reactions, finales and parallax (harness/keys-play-main.tsx, recorded by keys-play-record.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.KEYS_PLAY_CACHE ?? path.join(os.tmpdir(), 'vite-keys-play'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.KEYS_PLAY_PORT ?? 5243), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
