// Friends activity panel harness: the REAL FriendsActivityPanel at the right panel's widths,
// against stubbed auth / avatar decrypt / listening cover (no network).
//   npx vite --config harness/friends-activity.vite.config.ts      (serves :5347)
//   OUT=<dir> node harness/friends-activity-shots.mjs
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
  cacheDir: path.join(os.tmpdir(), `cipherline-friends-activity-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5347), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: /^(\.\.?\/)+utils\/integrations\/listeningArt$/, replacement: path.resolve(__dirname, 'friends-activity-art-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
