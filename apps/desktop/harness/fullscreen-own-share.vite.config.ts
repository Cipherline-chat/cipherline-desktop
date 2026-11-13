// Your own share in the fullscreen call view, and one video filling the screen.
//   npx vite --config harness/fullscreen-own-share.vite.config.ts      (serves :5498, PORT overrides)
//   OUT=<dir> node harness/fullscreen-own-share-shots.mjs              (env: BASE PW_CHROMIUM_EXE)
// No SFU: `@livekit/components-react` and the participants are stood in for, with canvas tracks.
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
  cacheDir: path.join(os.tmpdir(), `cipherline-fs-own-share-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5498), strictPort: true, open: false },
  optimizeDeps: { entries: ['harness/fullscreen-own-share.html'] },
  worker: { format: 'es' },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: '@livekit/components-react', replacement: path.resolve(__dirname, 'fullscreen-own-share-livekit-stub.ts') },
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: path.resolve(__dirname, 'share-notes-subscription-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: path.resolve(__dirname, 'share-hold-store-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
