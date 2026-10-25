// Easter-egg harness: renders the REAL egg surfaces (the group-of-two dialog over CreateGroupModal,
// Keys costumes, the alone-in-a-call echo, the version-tap badge, ...) against a stubbed
// network / auth / avatar decrypt. Scenes are picked with ?scene=...  (see easter-eggs-main.tsx).
//   npx vite --config harness/easter-eggs.vite.config.ts      (serves :5419)
//   node harness/easter-eggs-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-easter-eggs-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5419, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    // useAuth() needs no provider in the harness.
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'new-message-auth-stub.ts') },
    // Avatars resolve instantly to inline pictures — no network, no decrypt.
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'new-message-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
