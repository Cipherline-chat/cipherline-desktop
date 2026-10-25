// Banner redesign harness (harness/banners-main.tsx): the REAL ClBanner + every migrated banner + the app CSS.
//   npx vite --config harness/banners.vite.config.ts      (serves :5311)
//   node harness/banners-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stub = path.resolve(__dirname, 'banners-stubs.tsx')
export default defineConfig({
  root: app,
  cacheDir: process.env.BN_CACHE ?? path.join(os.tmpdir(), 'vite-banners-harness'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.BN_PORT ?? 5311), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stub },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: stub },
    { find: /^(\.\.?\/)+contexts\/ToastContext$/, replacement: stub },
    { find: /^(\.\.?\/)+hooks\/useAnnouncements$/, replacement: stub },
    { find: /^\.\/UpdateCardModal$/, replacement: stub },
    { find: /^(\.\.?\/)+utils\/secureLocalStore$/, replacement: stub },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
