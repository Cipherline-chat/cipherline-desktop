// In-app checkout layout harness: the REAL InAppCheckout / CheckoutLayout / checkout.css,
// with Stripe + axios swapped for stubs (harness/checkout-layout-stubs.tsx). The stubbed
// Payment Element is a plain block sized like the real iframe, incl. Link's expanded box.
//   npx vite --config harness/checkout-layout.vite.config.ts      (serves :5251)
//   node harness/checkout-layout-shots.mjs                        (env: OUT=<dir> BASE=... CDP=http://127.0.0.1:9510)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'checkout-layout-stubs.tsx')
export default defineConfig({
  root: app,
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.CHECKOUT_CACHE ?? path.join(os.tmpdir(), 'vite-checkout-layout'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.CHECKOUT_PORT ?? 5251), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'group-add-auth-stub.ts') },
    { find: '@stripe/stripe-js/pure', replacement: stubs },
    { find: '@stripe/react-stripe-js', replacement: stubs },
    { find: /^axios$/, replacement: stubs },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
