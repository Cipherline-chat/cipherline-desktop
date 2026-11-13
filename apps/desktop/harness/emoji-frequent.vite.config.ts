import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-emoji-frequent-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5499), strictPort: true, open: false },
})
