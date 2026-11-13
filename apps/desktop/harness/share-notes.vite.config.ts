// Screen-share notices harness (harness/share-notes-main.tsx): the REAL ScreenSharePickerModal, the call-bar
// quality panel and the in-call share notice, with the app's real stylesheets.
//   npx vite --config harness/share-notes.vite.config.ts      (serves :5351)
//   node harness/share-notes-shots.mjs                        (env: OUT BASE PW_CHROMIUM_EXE)
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
  cacheDir: process.env.SN_CACHE ?? path.join(os.tmpdir(), 'vite-share-notes-harness'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.SN_PORT ?? 5351), strictPort: true, open: false },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: path.resolve(__dirname, 'share-notes-subscription-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
