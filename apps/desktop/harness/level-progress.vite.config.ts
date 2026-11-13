// "Open someone's level" harness (harness/level-progress-main.tsx, shots: level-progress-shots.mjs).
//   npx vite --config harness/level-progress.vite.config.ts      (serves :5496)
//   node harness/level-progress-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
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
  // never the (shared, symlinked) node_modules
  cacheDir: process.env.LVP_CACHE ?? path.join(os.tmpdir(), 'cipherline-level-progress-vite-cache'),
  plugins: [whatsNewPlugin(), react()],
  server: { host: '127.0.0.1', port: Number(process.env.LVP_PORT ?? 5496), strictPort: true, open: false },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
  },
  resolve: { alias: [
    { find: /^(\.\.?\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'friends-narrow-auth-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useEncryptedAvatar$/, replacement: path.resolve(__dirname, 'friends-narrow-avatar-stub.ts') },
    { find: /^(\.\.?\/)+hooks\/useUserAchievements$/, replacement: path.resolve(__dirname, 'level-progress-ach-stub.ts') },
    { find: '@cipherline/shared', replacement: path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
  ] },
})
