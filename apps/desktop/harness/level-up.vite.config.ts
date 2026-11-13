// The level-up celebration harness (harness/level-up-main.tsx, shots: level-up-shots.mjs).
//   npx vite --config harness/level-up.vite.config.ts      (serves :5493)
//   node harness/level-up-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.LVU_CACHE ?? path.join(os.tmpdir(), 'cipherline-level-up-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.LVU_PORT ?? 5493), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'level-up-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
