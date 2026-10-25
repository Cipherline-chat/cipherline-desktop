import type { Plugin } from 'vite'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { parseChangelog, EMPTY_WHATS_NEW } from './src/utils/changelogParse'

/**
 * `virtual:whats-new`: the "What's new" release notes, read from
 * apps/desktop/CHANGELOG.md at BUILD time.
 *
 * The renderer imports the already-parsed notes (src/utils/whatsNew.ts), so the
 * dialog shown on the first launch after an update needs no network and no
 * markdown parser at runtime. Editing CHANGELOG.md hot-reloads the dev server.
 *
 * `## [Unreleased]` is included only by the dev server and tests (so a draft can
 * be previewed before the release is cut); a production build leaves it out.
 * A missing CHANGELOG.md is a warning, not a failure: the feature just has no
 * notes to show. The format and the release step that fills it in are in
 * docs/stable-release-pipeline.md ("What's new notes").
 */
export const WHATS_NEW_MODULE = 'virtual:whats-new'
const RESOLVED = '\0' + WHATS_NEW_MODULE

export function whatsNewPlugin(opts: { changelogPath?: string; includeUnreleased?: boolean } = {}): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = opts.changelogPath ?? path.resolve(here, 'CHANGELOG.md')
  let isBuild = false
  return {
    name: 'cipherline-whats-new',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    resolveId(id) {
      return id === WHATS_NEW_MODULE ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      this.addWatchFile(file)
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        this.warn(`whats-new: cannot read ${file}; the app will have no release notes to show`)
      }
      const data = text ? parseChangelog(text) : EMPTY_WHATS_NEW
      const includeUnreleased = opts.includeUnreleased ?? !isBuild
      const out = { releases: data.releases, unreleased: includeUnreleased ? data.unreleased : null }
      return `export default ${JSON.stringify(out)}`
    },
  }
}
