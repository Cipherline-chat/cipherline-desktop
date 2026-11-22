// Push-to-talk background-keys harness (harness/ptt-keys-main.tsx): the REAL VoiceVideoSettings,
// KeybindSettings and ToastProvider, with main's hold-key:check answer stubbed per scene.
//   PTT_PORT=5331 npx vite --config harness/ptt-keys.vite.config.ts
//   node harness/ptt-keys-shots.mjs                (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { whatsNewPlugin } from '../vite-plugin-whats-new'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'vite-ptt-keys-harness'),
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: Number(process.env.PTT_PORT ?? 5331), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.1.3'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
