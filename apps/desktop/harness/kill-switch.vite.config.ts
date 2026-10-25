// Kill-switch blocking screens harness (harness/kill-switch-main.tsx).
//   npx vite --config harness/kill-switch.vite.config.ts      (serves :5241)
//   node harness/kill-switch-shots.mjs                         (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// REAL: UpdateRequiredScreen, AppSuspendedScreen, ClientBlockScreen and their CSS. Props are
// fixed per ?screen= so every state can be screenshotted without a server or an updater.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.KS_CACHE ?? path.join(os.tmpdir(), 'vite-kill-switch'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.KS_PORT ?? 5241), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
