// Night dive harness: real HomePanel / ChatPane / SettingsScreen / NightDiveTransition under <html data-depth>.
//   npx vite --config harness/night-dive.vite.config.ts   (serves :5321)
//   node harness/night-dive-shots.mjs <outDir>
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
  cacheDir: process.env.ND_CACHE ?? path.join(os.tmpdir(), 'vite-night-dive'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.ND_PORT ?? 5321), strictPort: true, open: false },
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
