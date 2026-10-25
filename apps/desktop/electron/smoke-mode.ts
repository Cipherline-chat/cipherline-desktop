/**
 * When is this process the CI smoke test (scripts/smoke-test.mjs)?
 *
 * Smoke mode switches off the updater, keystore persistence, the
 * single-instance lock, the DevTools closer and the staging lock, and moves the
 * app origin — all right for a 30-second "does the packaged app paint" check
 * on a CI runner, all wrong for a real install. It used to be selected by the
 * `CIPHERLINE_SMOKE_TEST` environment variable alone, which any process
 * running as the user can set persistently (e.g. `setx`), silently freezing
 * updates on that machine.
 *
 * The smoke test runs the very binary that ships, so no build-time flag can
 * tell the two apart. What does: a packaged build enters smoke mode only when
 * the harness's explicit launch argument AND a `--user-data-dir` switch are on
 * the command line as well. A normal launch (Start menu, dock, autostart,
 * protocol handler, the updater's relaunch) carries neither, so an inherited
 * environment variable can no longer change how the installed app behaves,
 * and even a deliberate smoke launch runs against a separate profile, never
 * the user's real one. Unpackaged (dev) builds keep the env-only behaviour.
 *
 * No `electron` import, so the decision is unit-testable.
 */

export const SMOKE_TEST_ENV = 'CIPHERLINE_SMOKE_TEST';
/** Passed by scripts/smoke-test.mjs. Keep the two in sync. */
export const SMOKE_TEST_ARG = '--cipherline-smoke-test';

export function decideSmokeTestMode(
    env: Record<string, string | undefined>,
    argv: readonly string[],
    isPackaged: boolean,
): boolean {
    if (!env[SMOKE_TEST_ENV]) return false;
    if (!isPackaged) return true;
    return argv.includes(SMOKE_TEST_ARG) && argv.some(a => typeof a === 'string' && a.startsWith('--user-data-dir='));
}
