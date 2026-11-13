// "My halo colour isn't reflected in the rail / Friends page" harness (harness/cosmetics-everywhere-main.tsx):
// the REAL StatusPicker (bottom-left of the rail) and the REAL FriendsPane, fed made-up users that wear recoloured
// decorations. Run it against any checkout (it only imports ../src) to get that checkout's before/after.
//   npx vite --config harness/cosmetics-everywhere.vite.config.ts   (serves :5351; env PORT, TAG, SHARED_INDEX)
//   node harness/cosmetics-everywhere-shots.mjs                     (env: OUT=<dir> TAG=before|after BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), `cipherline-cosmetics-everywhere-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5351), strictPort: true, open: false, fs: { strict: false } },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: 'mammoth', replacement: 'mammoth/mammoth.browser.min.js' },
    { find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' },
    { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
