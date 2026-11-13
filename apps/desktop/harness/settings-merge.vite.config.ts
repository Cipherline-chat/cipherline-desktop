// Settings merge harness (Activity & Style + Steam under Profile): the REAL SettingsScreen, real hooks, real providers, a verified Steam user.
//   npx vite --config harness/settings-merge.vite.config.ts      (serves :5391)
//   node harness/settings-merge-shots.mjs <outDir> <prefix> <shots>            (env: BASE, PW_CHROMIUM_EXE)
// Fakes: the network (axios adapter in -main), useAuth + avatar decrypt (aliases), window.electronAPI (partial).
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
  cacheDir: process.env.SR_CACHE ?? path.join(os.tmpdir(), 'vite-settings-merge'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.SR_PORT ?? 5391), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)*(contexts\/)?AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'settings-merge-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'dialogs-restyle-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
