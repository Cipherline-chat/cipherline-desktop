// Home pins reorder harness: the real HomePanel with drag / Alt+Arrow pin reordering.
//   npx vite --config harness/home-pins.vite.config.ts   (serves :5327)
//   node harness/home-pins-shots.mjs <outDir>
// Fakes: the network (axios adapter in -main), useAuth (alias), window.electronAPI (partial). Avatars fall back to initials.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.HP_CACHE ?? path.join(os.tmpdir(), 'vite-home-pins'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.HP_PORT ?? 5327), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)*(contexts\/)?AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'settings-redesign-auth-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
