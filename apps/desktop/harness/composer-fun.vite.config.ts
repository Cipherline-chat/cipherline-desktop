// Composer touches harness (harness/composer-fun-main.tsx, driven by harness/composer-fun-shots.mjs):
// the REAL dialog / impact FX / spam reaction / chime / ripple components, the REAL logic modules
// (composerFun, messageEntrance, mentionTokens) and the REAL CSS, in a feed + composer whose markup
// mirrors ChatPane's. ChatPane itself needs a live backend, so it is mirrored, not mounted.
//   npx vite --config harness/composer-fun.vite.config.ts      (serves :5463)
//   node harness/composer-fun-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), 'cipherline-composer-fun-vite-cache'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.CF_PORT ?? 5463), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'new-message-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
