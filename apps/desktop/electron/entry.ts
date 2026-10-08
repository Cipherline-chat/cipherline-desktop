/**
 * Electron entry point (package.json "main"). Chooses between the app
 * (./main.ts) and the out-of-process screen-share source lister
 * (./sources-helper.ts), which is the same executable started with
 * SOURCES_HELPER_FLAG — see pickerEnumeration in ./capture-flags.ts.
 *
 * Has to be a separate file: main.ts and the modules it imports do real work
 * at load time (paths under the user's profile, the single-instance lock,
 * secure storage), none of which may happen in the helper. Keep this file to
 * the one decision — nothing else loads before it is made.
 */
import { isSourcesHelperArgv } from './sources-helper-protocol';

// require(), not import: the load must be conditional and synchronous, and
// a static import of either file would run its side effects in both roles.
if (isSourcesHelperArgv(process.argv)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./sources-helper');
} else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./main');
}
