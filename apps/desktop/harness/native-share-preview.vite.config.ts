// Linux sharer tile harness (harness/native-share-preview-main.tsx): the REAL NativeSharePreview fed by the REAL preview hub.
//   npx vite --config harness/native-share-preview.vite.config.ts   (serves :5321)
//   node harness/native-share-preview-shots.mjs                      (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.NSP_CACHE ?? path.join(os.tmpdir(), 'vite-native-share-preview-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.NSP_PORT ?? 5321), strictPort: true, open: false },
})
