import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// Keys' wardrobe on Home (harness/keys-wardrobe-main.tsx, shot by keys-wardrobe-shots.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.KEYS_WARDROBE_CACHE ?? path.join(os.tmpdir(), 'vite-keys-wardrobe'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.KEYS_WARDROBE_PORT ?? 5251), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
