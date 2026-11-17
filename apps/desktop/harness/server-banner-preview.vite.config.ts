// Server Settings → Overview banner preview harness: the REAL ServerSettingsModal (dock) and the REAL
// ClImageCropper against stubbed network, contexts, attachments and avatar decrypt.
//   npx vite --config harness/server-banner-preview.vite.config.ts     (serves :5361; PORT=... to move it)
//   node harness/server-banner-preview-shots.mjs                       (env: OUT=<dir> LABEL=before|after BASE=...)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(__dirname, '..')
const stubs = path.resolve(__dirname, 'dialogs-wave3-stubs.ts')
export default defineConfig({
  root: app,
  cacheDir: path.join(os.tmpdir(), `cipherline-server-banner-vite-cache-${process.env.TAG ?? 'x'}`),
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5361), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.0.23-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/ToastContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+contexts\/SubscriptionContext$/, replacement: stubs },
    { find: /^(\.\.?\/)+(utils\/)?secureLocalStore$/, replacement: stubs },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'server-banner-avatar-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useAttachments$/, replacement: path.resolve(__dirname, 'server-dialogs-attachments-stub.ts') },
    { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
