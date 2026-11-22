// Slowmode / age-restricted harness (harness/slowmode-age-main.tsx, shots by
// harness/slowmode-age-shots.mjs). The REAL AgeGatePane and ChannelModerationSection;
// the composer strip / header chips are mirrored ChatPane markup using the real util
// functions. No network.
//   SM_PORT=5392 npx vite --config harness/slowmode-age.vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.SM_CACHE ?? path.join(os.tmpdir(), 'vite-slowmode-age'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.SM_PORT ?? 5392), strictPort: true, open: false },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
