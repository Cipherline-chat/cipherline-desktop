// Stickers backup + device transfer, REAL-APP check: the app's OWN vite.config (every plugin and alias unchanged), with
// only the dependency cache moved out of the shared node_modules, the port moved off the shared dev stack's 5174,
// and VITE_API_HOST pinned to the ISOLATED loopback API before the first launch.
//   SBT_API_HOST=127.0.0.1:13223 PORT=5323 npx vite --config harness/stickers-backup-transfer/vite.config.ts
import { mergeConfig, type UserConfig } from 'vite'
import * as os from 'os'
import * as path from 'path'
import base from '../../vite.config'

const apiHost = process.env.SBT_API_HOST ?? '127.0.0.1:13223'
if (!/^127\.0\.0\.1:\d+$/.test(apiHost)) throw new Error(`refusing a non-loopback API host ${apiHost}`)
process.env.VITE_API_HOST = apiHost

export default mergeConfig(base as UserConfig, {
  cacheDir: path.join(os.tmpdir(), 'cipherline-sbt-vite-cache'),
  // The isolated MinIO behind the dev server's own origin (the API presigns for http://127.0.0.1:5323 via
  // MINIO_PUBLIC_ENDPOINT): the renderer's CSP connect-src allows the dev server, not a second loopback port.
  // Host is kept (changeOrigin false), so MinIO checks the signature against the presigned host.
  server: {
    host: '127.0.0.1', port: Number(process.env.PORT ?? 5323), strictPort: true, open: false,
    proxy: { '/cipherline/': { target: process.env.SBT_MINIO ?? 'http://127.0.0.1:9323', changeOrigin: false } },
  },
  define: { 'import.meta.env.VITE_API_HOST': JSON.stringify(apiHost) },
})
