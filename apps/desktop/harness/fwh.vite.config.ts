// Firewall hitch, REAL-APP trace run (harness/fwh-trace.mjs): the app's own vite.config with only the dep cache
// moved, the port moved off the shared dev stack's 5174, and VITE_API_HOST pinned to an ISOLATED loopback API
// (never the shared dev stack, staging or prod).
//   FWH_API_HOST=127.0.0.1:13197 PORT=5297 npx vite --config harness/fwh.vite.config.ts
import { mergeConfig, type UserConfig } from 'vite'
import * as os from 'os'
import * as path from 'path'
import base from '../vite.config'

const apiHost = process.env.FWH_API_HOST ?? '127.0.0.1:13197'
if (!/^127\.0\.0\.1:\d+$/.test(apiHost)) throw new Error(`refusing a non-loopback API host ${apiHost}`)
process.env.VITE_API_HOST = apiHost

export default mergeConfig(base as UserConfig, {
  cacheDir: path.join(os.tmpdir(), 'cipherline-fwh-vite-cache'),
  server: {
    host: '127.0.0.1', port: Number(process.env.PORT ?? 5297), strictPort: true, open: false,
    proxy: { '/cipherline/': { target: process.env.FWH_MINIO ?? 'http://127.0.0.1:9297', changeOrigin: false } },
  },
  define: { 'import.meta.env.VITE_API_HOST': JSON.stringify(apiHost) },
})
