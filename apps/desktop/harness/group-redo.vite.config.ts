// Group redo harness: the REAL GroupContextHeader + GroupSettingsModal (+ AddGroupMembersModal)
// against stubbed auth / avatars / network.
//   npx vite --config harness/group-redo.vite.config.ts      (serves :5301)
//   node harness/group-redo-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'group-redo-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-group-redo-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5301, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/ToastContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useAttachments$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useAvatarBroadcast$/, replacement: stubs },
    { find: /^(\.\.?\/)+utils\/avatarKeyStore$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: stubs },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
