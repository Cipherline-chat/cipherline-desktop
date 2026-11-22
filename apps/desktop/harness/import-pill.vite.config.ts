// Import-pill harness: the light-theme harness (REAL drift shell + title bar)
// with the REAL DiscordImportHost / ImportPill mounted in the title bar in a
// fixed state (?pill=<state>, harness/import-pill-job-stub.ts). Shot by
// harness/import-pill-shots.mjs.
//   LT_PORT=5452 npx vite --config harness/import-pill.vite.config.ts
import { mergeConfig, type Plugin } from 'vite'
import * as path from 'path'
import { fileURLToPath } from 'url'
import base from './light-theme.vite.config'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stub = path.resolve(__dirname, 'import-pill-job-stub.ts')
// Only DiscordImportHost's view of the job is swapped; the stub re-exports the real module.
const redirect: Plugin = {
  name: 'import-pill-job-stub',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer && /DiscordImportHost\.tsx$/.test(importer) && /utils\/discordImport\/backgroundImport$/.test(source)) return stub
    return null
  },
}
export default mergeConfig(base, { plugins: [redirect] })
