/**
 * manualUpdateCheck.ts — the "Check for updates" button's own little state
 * machine, kept pure so it can be unit-tested without Electron, a network, or
 * a rendered component (same split as electron/updater-state.ts, which owns
 * the *updater's* lifecycle; this owns only what one button click looks like).
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * main.ts checks for updates once at startup and then every four hours. There
 * was no way to force a check, so "has the fix landed yet?" was unanswerable:
 * on 2026-09-05 a fix was committed at 20:26Z, the first staging build
 * containing it published at 22:09Z, and it was reported still broken by a
 * client still running the 19:49Z pre-fix build — with no in-app way to find
 * that out. The only lever that forced a check was toggling the update channel
 * back and forth, which works purely by side effect and actually changes which
 * release stream you follow.
 *
 * ── Why the result is inferred, not returned ─────────────────────────────────
 * `autoUpdater.checkForUpdates()` resolves for BOTH outcomes — an update found
 * and nothing new — so its return value can't distinguish them. The honest
 * source of truth is the updater state the main process already pushes over
 * `update:state` (electron/updater-state.ts), which this module reads rather
 * than standing up a second, parallel notion of "is there an update". So:
 *
 *   • a non-idle updater phase observed WHILE checking → an update was found
 *   • the check settled and the updater is still idle  → you're up to date
 *
 * The settle step is deliberately delayed by SETTLE_GRACE_MS: the `update:state`
 * push and the IPC reply are two separate messages, and concluding "up to date"
 * the instant the reply lands would race a state push that is already on its
 * way. Waiting a beat costs nothing and removes a wrong answer.
 */

/** A phase-only view of UpdateStateShape (env.d.ts) — everything this module
 *  needs from the updater without depending on the version/percent fields. */
export interface UpdaterStateLike {
    phase: 'idle' | 'available' | 'downloading' | 'ready' | 'manual';
    version?: string;
}

export type ManualCheckState =
    /** Nothing has been asked yet — the resting state of the button. */
    | { kind: 'idle' }
    /** A check is in flight. */
    | { kind: 'checking' }
    /** The check finished and the updater still has nothing. */
    | { kind: 'up-to-date' }
    /** The check turned up a build; the updater is downloading it in the
     *  background (or has already handed off to the manual-download path). */
    | { kind: 'found'; version: string }
    /** No updater in this build (dev server / smoke test). Distinct from
     *  'up-to-date' on purpose — "we didn't ask" is not "there's nothing". */
    | { kind: 'unsupported' }
    | { kind: 'error'; message: string };

/** How long to wait after the check settles before reading the updater state,
 *  so an in-flight `update:state` push isn't missed. See the module doc. */
export const SETTLE_GRACE_MS = 900;
/** Hard ceiling on a check that never settles (a hung request). Reported as an
 *  error, never as "up to date" — a timeout is not evidence of anything. */
export const CHECK_TIMEOUT_MS = 20_000;
/** How long a finished result stays on screen before the row returns to rest. */
export const RESULT_LINGER_MS = 8_000;

/** Start a check. Re-entrant clicks while one is in flight are ignored rather
 *  than restarting it — the button is disabled meanwhile, but a keyboard
 *  repeat or a double-fire shouldn't be able to stack timers either. */
export function beginCheck(current: ManualCheckState): ManualCheckState {
    if (current.kind === 'checking') return current;
    return { kind: 'checking' };
}

/**
 * Fold the live updater state in. Only ever upgrades a `checking` state: once
 * a result is on screen, a later background transition must not silently
 * rewrite what the user was just told they clicked for. (The update rail tile
 * is what reports ongoing updater activity; this row reports one click.)
 */
export function observeUpdaterState(current: ManualCheckState, updater: UpdaterStateLike): ManualCheckState {
    if (current.kind !== 'checking') return current;
    if (updater.phase === 'idle') return current;
    return { kind: 'found', version: updater.version ?? '' };
}

/**
 * Resolve a check that came back cleanly.
 *
 * @param dispatched false when the build has no updater to ask (dev/smoke),
 *   which is reported as `unsupported` rather than a reassuring lie.
 */
export function settleCheck(
    current: ManualCheckState,
    dispatched: boolean,
    updater: UpdaterStateLike,
): ManualCheckState {
    if (current.kind !== 'checking') return current;
    if (!dispatched) return { kind: 'unsupported' };
    if (updater.phase !== 'idle') return { kind: 'found', version: updater.version ?? '' };
    return { kind: 'up-to-date' };
}

/** Resolve a check that threw. Ignored unless a check is actually in flight, so
 *  a late rejection can't overwrite an already-displayed result. */
export function failCheck(current: ManualCheckState, err: unknown): ManualCheckState {
    if (current.kind !== 'checking') return current;
    return { kind: 'error', message: describeCheckError(err) };
}

/** Return a finished result to rest. A check still in flight is left alone. */
export function dismissResult(current: ManualCheckState): ManualCheckState {
    if (current.kind === 'checking' || current.kind === 'idle') return current;
    return { kind: 'idle' };
}

/**
 * Turn whatever came back out of the IPC into one line a human can read.
 *
 * Electron prefixes every rejection from `ipcMain.handle` with
 * "Error invoking remote method 'x': ", which is implementation noise in a
 * settings row — stripped here rather than in the component so it's covered by
 * tests. An empty/unrecognisable failure still gets a real sentence: a blank
 * error message would render as a row that just looks broken.
 */
export function describeCheckError(err: unknown): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    const unwrapped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').trim();
    if (!unwrapped) return "Couldn't reach the update server.";
    return unwrapped.length > 160 ? `${unwrapped.slice(0, 159)}…` : unwrapped;
}

/** Everything the row needs to render, derived in one place so the component
 *  holds no copy of the wording and the wording itself is testable. */
export interface ManualCheckDescriptor {
    /** Button label. */
    label: string;
    /** Status line under the row, or null when there's nothing worth saying. */
    detail: string | null;
    tone: 'neutral' | 'busy' | 'ok' | 'info' | 'error';
    /** A check is in flight — drives the spinner and aria-busy. */
    busy: boolean;
}

export function describeManualCheck(state: ManualCheckState): ManualCheckDescriptor {
    switch (state.kind) {
        case 'idle':
            return { label: 'Check now', detail: null, tone: 'neutral', busy: false };
        case 'checking':
            return { label: 'Checking…', detail: 'Asking the update server…', tone: 'busy', busy: true };
        case 'up-to-date':
            return { label: 'Check now', detail: "You're up to date.", tone: 'ok', busy: false };
        case 'found':
            return {
                label: 'Check now',
                detail: state.version
                    ? `Update found — downloading v${state.version} in the background.`
                    : 'Update found — downloading in the background.',
                tone: 'info',
                busy: false,
            };
        case 'unsupported':
            return {
                label: 'Check now',
                detail: 'Update checks only run in a packaged build.',
                tone: 'neutral',
                busy: false,
            };
        case 'error':
            return { label: 'Try again', detail: state.message, tone: 'error', busy: false };
    }
}
