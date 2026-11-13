// Safety-code "Share mine back" harness: the REAL SafetyNumberEmbed, driven with real clicks.
//   npx vite --config harness/safety-share-back.vite.config.ts      (serves :5441)
//   node harness/safety-share-back-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-safety-share-back-vite-cache'),
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: Number(process.env.SB_PORT ?? 5441), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'moments-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
