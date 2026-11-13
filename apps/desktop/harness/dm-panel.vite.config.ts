// Cosmetic thumbnails harness (harness/dm-panel-main.tsx): the REAL AvatarDecoration + decoration art + the
// picker's real stylesheets, in a replica of the Settings picker grid (36px tiles) and at full card size (92px).
//   npx vite --config harness/cosmetic-thumbs.vite.config.ts      (serves :5347)
//   node harness/cosmetic-thumbs-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.CT_CACHE ?? path.join(os.tmpdir(), 'vite-dm-panel-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.CT_PORT ?? 5349), strictPort: true, open: false },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
