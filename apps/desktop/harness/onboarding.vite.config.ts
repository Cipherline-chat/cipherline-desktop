// Onboarding screenshots / pointer-parallax harness: the REAL app via the in-app
// `?ob-harness=<step>` route (App.tsx, dev only), served from a private Vite
// cache so it never touches the shared node_modules/.vite.
//   npx vite --config harness/onboarding.vite.config.ts   (serves :5391)
//   node harness/onboarding-shots.mjs                      (env: OUT, BASE, PW_CHROMIUM_EXE)
import { defineConfig, mergeConfig } from 'vite'
import * as os from 'os'
import * as path from 'path'
import appConfig from '../vite.config'

export default defineConfig(async (env) => {
  const resolved = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return mergeConfig(resolved, {
    cacheDir: path.join(os.tmpdir(), 'cipherline-onboarding-vite-cache'),
    server: { host: '127.0.0.1', port: 5391, strictPort: true, open: false },
  })
})
