// Safety-verify harness: the REAL SafetyVerifyHint (in a stand-in DM header, beside the real TrustBadge)
// and the REAL MomentHost playing the first-verification ceremony, driven through the real
// keyVerification.markVerified commit point.
//   npx vite --config harness/safety-verify.vite.config.ts      (serves :5439)
//   node harness/safety-verify-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
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
  cacheDir: path.join(os.tmpdir(), 'cipherline-safety-verify-vite-cache'),
  plugins: [react(), whatsNewPlugin()],
  server: { host: '127.0.0.1', port: Number(process.env.SV_PORT ?? 5439), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.22'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'moments-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
