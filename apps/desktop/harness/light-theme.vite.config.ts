// Light theme harness (harness/light-theme-main.tsx, shot by harness/light-theme-shots.mjs).
// The REAL HomePanel / ServerChannelList / ChatPane / ServerContextPanel /
// FriendsPane / SettingsScreen / dialogs inside Dashboard's drift shell, in
// either theme (?theme=dark|light).
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts
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
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.LT_CACHE ?? path.join(os.tmpdir(), 'vite-light-theme'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.LT_PORT ?? 5431), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.1.2'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)*(contexts\/)?AuthContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)*(contexts\/)?SubscriptionContext(\.tsx)?$/, replacement: path.resolve(__dirname, 'window-sizes-stubs.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'settings-polish-avatar-stub.ts') },
    { find: /^@stripe\/react-stripe-js$/, replacement: path.resolve(__dirname, 'window-sizes-stripe-stub.tsx') },
    { find: /^@stripe\/stripe-js\/pure$/, replacement: path.resolve(__dirname, 'window-sizes-stripe-stub.tsx') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
