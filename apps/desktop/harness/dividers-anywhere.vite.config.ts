import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
// "Dividers anywhere" harness (harness/dividers-anywhere-main.tsx, shot by
// harness/dividers-anywhere-shots.mjs). Own Vite, own port, own cache: never the shared dev stack.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.DA_CACHE ?? path.join(os.tmpdir(), 'vite-dividers-anywhere'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.DA_PORT ?? 5241), strictPort: true, open: false },
  resolve: { alias: { '@cipherline/shared': path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') } },
})
