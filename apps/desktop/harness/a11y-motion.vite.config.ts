// Animated-image modes harness: the REAL GifPlayer in a chat-like message, in each
// Settings → Accessibility → Animated images mode.
//   A11Y_PORT=5393 npx vite --config harness/a11y-motion.vite.config.ts
//   node harness/a11y-motion-shots.mjs <outDir>
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-a11y-motion-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.A11Y_PORT ?? 5393), strictPort: true, open: false },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
