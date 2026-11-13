// Voice gate Automatic harness (harness/voice-gate-main.tsx): the REAL VoiceVideoSettings.
//   npx vite --config harness/voice-gate.vite.config.ts      (serves :5312)
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
  cacheDir: path.join(os.tmpdir(), 'vite-voice-gate-harness'),
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: 5312, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
