// Settings redesign harness: the REAL SettingsScreen with every pane, real hooks, real providers.
//   npx vite --config harness/settings-redesign.vite.config.ts      (serves :5311)
//   node harness/settings-redesign-shots.mjs <outDir>              (env: BASE, PW_CHROMIUM_EXE)
// Fakes: the network (axios adapter in -main), useAuth + avatar decrypt (aliases), window.electronAPI (partial).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.SR_CACHE ?? path.join(os.tmpdir(), 'vite-settings-redesign'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.SR_PORT ?? 5311), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)*(contexts\/)?AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'settings-redesign-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'settings-polish-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
