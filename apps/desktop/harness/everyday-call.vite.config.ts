// "Everyday touches" call harness: the three-hour card and the popcorn bucket (components/call/CallMilestones.tsx).
//   npx vite --config harness/everyday-call.vite.config.ts      (serves :5432; EVERYDAY_CALL_PORT overrides)
import { defineConfig, mergeConfig } from 'vite'
import * as path from 'path'
import { fileURLToPath } from 'url'
import base from './everyday.vite.config'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export default mergeConfig(base, defineConfig({
  cacheDir: process.env.EVERYDAY_CALL_CACHE ?? '/tmp/cipherline-everyday-call-vite-cache',
  optimizeDeps: { entries: ['harness/everyday-call.html'] },
  server: { port: Number(process.env.EVERYDAY_CALL_PORT ?? 5432) },
  resolve: { alias: [
    { find: '@livekit/components-react', replacement: path.resolve(__dirname, 'everyday-livekit-stub.ts') },
  ] },
}))
