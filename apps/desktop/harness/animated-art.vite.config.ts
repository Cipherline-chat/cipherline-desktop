// Animated server art harness (harness/animated-art-main.tsx): the REAL ClImageCropper (with its real
// animatedCrop worker) and the REAL ServerIcon, plus the app CSS.
//   npx vite --config harness/animated-art.vite.config.ts      (serves :5321)
//   node harness/animated-art-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const hook = path.resolve(__dirname, 'animated-art-hook-stub.ts')
export default defineConfig({
  root: app,
  cacheDir: process.env.AA_CACHE ?? path.join(os.tmpdir(), 'vite-animated-art-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.AA_PORT ?? 5321), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    // Network + decrypt replaced by an in-page map of art; the gate, the component and the cropper are real.
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: hook },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
