// Beta diagnostics UI harness (harness/beta-diag-main.tsx).
//   npx vite --config harness/beta-diag.vite.config.ts      (serves :5247)
//   node harness/beta-diag-shots.mjs                         (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// REAL: CallRatingCardView, BetaDiagnosticsNotice, ReportProblemCard + BetaDiagnosticsSetting and their CSS.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
export default defineConfig({
  root: app,
  cacheDir: process.env.BD_CACHE ?? path.join(os.tmpdir(), 'vite-beta-diag'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.BD_PORT ?? 5247), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'beta-diag-auth-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
