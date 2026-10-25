/**
 * E-6: a packaged build ignores debugging switches.
 *
 * The `EnableNodeCliInspectArguments` fuse (package.json `build.electronFuses`)
 * already makes the packaged binary ignore Node's `--inspect*` arguments. It
 * does NOT cover `--remote-debugging-port` / `--remote-debugging-pipe`, which
 * are Chromium switches: with either one on the command line, any process
 * running as the same user can attach over the Chrome DevTools Protocol to the
 * signed, entitled app (macOS: inheriting its microphone / camera / Screen
 * Recording grants; every platform: scripting the renderer and the preload
 * bridge). Nothing in a shipped Cipherline legitimately uses either, so the
 * packaged app drops them before Chromium acts on them.
 *
 * The CI smoke test (scripts/smoke-test.mjs) deliberately does NOT use them
 * either: Playwright's Electron driver needs `--inspect` AND the debugging port,
 * which this hardening removes, so the smoke run reports through
 * ./smoke-report.ts instead of attaching a debugger. Exempting smoke mode here
 * would leave exactly the hole this closes behind one more command-line
 * argument that malware could pass as easily as the harness does.
 *
 * Unpackaged (`electron .`, dev) builds keep every switch: that is how the
 * developer attaches DevTools.
 *
 * No `electron` import, so the rule is unit-testable (debug-switches.test.ts).
 */

/** Chromium + Node switches that open a debugging channel. Names carry no `--`. */
export const BLOCKED_DEBUG_SWITCHES: readonly string[] = [
    // Chromium: a CDP endpoint (TCP port or inherited pipe) into the browser process.
    'remote-debugging-port',
    'remote-debugging-pipe',
    'remote-debugging-address',
    'remote-allow-origins',
    // Node / V8 inspector. The fuse already disables these in a packaged
    // binary; listed so the intent is stated once, in code, and so a build
    // whose fuses were not applied still refuses them.
    'inspect',
    'inspect-brk',
    'inspect-port',
    'inspect-publish-uid',
    'inspect-brk-node',
];

/** The slice of `Electron.CommandLine` this needs. */
export interface CommandLineLike {
    hasSwitch(name: string): boolean;
    removeSwitch(name: string): void;
}

/**
 * Remove every blocked switch from `commandLine` when `isPackaged`. Returns the
 * names that were present and removed (for a log line), never throws.
 */
export function stripDebugSwitches(commandLine: CommandLineLike, isPackaged: boolean): string[] {
    if (!isPackaged) return [];
    const removed: string[] = [];
    for (const name of BLOCKED_DEBUG_SWITCHES) {
        try {
            if (commandLine.hasSwitch(name)) {
                commandLine.removeSwitch(name);
                removed.push(name);
            }
        } catch { /* a switch we cannot remove is not a reason to fail startup */ }
    }
    return removed;
}
