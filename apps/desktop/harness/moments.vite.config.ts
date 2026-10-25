// Full-screen moments harness: the REAL MomentHost over a static app backdrop; each moment is
// played on demand. Scenes are picked with ?scene=... (see moments-main.tsx).
//   npx vite --config harness/moments.vite.config.ts      (serves :5427)
//   node harness/moments-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=... VIDEO=1)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-moments-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5427, strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'moments-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'new-message-avatar-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
