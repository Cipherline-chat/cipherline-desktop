// Website profile screenshots (harness/website-profile-main.tsx): the REAL ProfileModal (preview + full)
// and DmProfileCard, fed by the components' own API fetches (only AuthContext is stubbed: the viewer id).
//   npx vite --config harness/website-profile.vite.config.ts      (serves :5361)
// The capture script answers https://api.cipherline.chat/v1/** from a signed-in session (Playwright routes).
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
  cacheDir: process.env.CT_CACHE ?? path.join(os.tmpdir(), 'vite-website-profile-harness'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.CT_PORT ?? 5361), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  optimizeDeps: { entries: ['harness/website-profile-main.tsx'] },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'website-profile-auth-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
