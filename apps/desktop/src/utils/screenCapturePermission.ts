/**
 * macOS Screen Recording (TCC) gating for the screen-share picker.
 *
 * Why this exists
 * ---------------
 * On macOS, enumerating shareable windows/screens is gated by the per-app
 * "Screen Recording" TCC permission (System Settings → Privacy & Security →
 * Screen Recording; "Screen & System Audio Recording" on Sequoia+). Without
 * it the picker had nothing to show and fell through to its generic
 * "No windows found" empty state, so the feature just looked broken.
 *
 * Two verified behaviours drive the branching here:
 *
 *  1. Since electron/electron#43080 (and still on the 43-x-y branch this app
 *     builds against), `desktopCapturer.getSources()` calls Chromium's
 *     `ui::TryPromptUserForScreenCapture()` — i.e. `CGRequestScreenCaptureAccess()`
 *     — BEFORE enumerating, and REJECTS with "Failed to get sources." when it
 *     returns false. So on macOS an ungranted permission is a rejected promise,
 *     not an empty array. (The older, still-widely-described behaviour — a
 *     degraded list of only your own windows with no names — is the raw
 *     CoreGraphics path, not what Electron 43 does.)
 *  2. `CGRequestScreenCaptureAccess()` caches its answer per PROCESS: once it
 *     has returned false, it keeps returning false for the life of that
 *     process even after the user flips the toggle in System Settings. This is
 *     why macOS itself offers "Quit & Reopen" — and why a grant with a still
 *     failing enumeration means "relaunch", not "try again".
 *
 * Unlike camera and microphone, Electron exposes NO API to request this
 * permission: `systemPreferences.askForMediaAccess()` accepts only
 * 'microphone' | 'camera'. (The previous code here called a non-existent
 * `systemPreferences.askForScreenCaptureAccess()` behind a
 * `typeof … === 'function'` guard, so it was a permanent no-op — nothing was
 * ever asked and nothing was ever surfaced.) `getSources()` itself is the only
 * thing that can raise the one-shot system prompt; beyond that all we can do
 * is *detect* via `systemPreferences.getMediaAccessStatus('screen')` (which
 * wraps the non-prompting `CGPreflightScreenCaptureAccess()`) and walk the
 * user to System Settings by hand.
 *
 * Windows and Linux have no equivalent gate (Linux's own wrinkle is the
 * Wayland portal, handled separately in electron/main.ts and in the picker's
 * Linux branch) and are deliberately untouched by all of this.
 *
 * This module is deliberately pure so the branch that decides what the picker
 * shows is unit-testable without Electron.
 */

/** Exactly the strings Electron's `getMediaAccessStatus` can return. */
export type MediaAccessStatus =
    | 'not-determined'
    | 'granted'
    | 'denied'
    | 'restricted'
    | 'unknown';

/**
 * What the main process reports back for screen capture.
 * `not-applicable` = not macOS, i.e. there is no such permission to check.
 */
export type ScreenCaptureAccess = MediaAccessStatus | 'not-applicable';

/** What the picker should render for the current source list. */
export type ScreenSourcesVerdict =
    /** Normal case — show the thumbnail grid. */
    | 'sources'
    /**
     * Nothing to show, and no permission explanation is warranted: either a
     * non-macOS host, or macOS where the enumeration succeeded and simply came
     * back empty (a genuinely different bug, not a TCC one).
     */
    | 'empty'
    /** macOS is withholding the sources because Screen Recording isn't granted. */
    | 'macos-permission-required'
    /**
     * macOS reports the permission as granted, yet the enumeration still
     * failed — the signature of a process whose cached
     * `CGRequestScreenCaptureAccess()` answer is stuck at false because the
     * grant happened after launch. Only a relaunch clears it.
     */
    | 'macos-relaunch-required';

export interface ScreenSourcesInput {
    /** `window.electronAPI.platform`. */
    platform: 'windows' | 'mac' | 'linux';
    /** Result of the `screen-capture:get-access-status` IPC. */
    access: ScreenCaptureAccess;
    /** How many sources `getSources()` handed back for the active request. */
    sourceCount: number;
    /**
     * Whether the last `getSources()` call REJECTED. On macOS 43.x that is the
     * actual signal for a missing Screen Recording grant, so it must be fed in
     * — an empty list alone would under-report the problem.
     */
    fetchFailed?: boolean;
}

/**
 * Decide what the picker renders. Anything non-empty wins outright — a
 * partially-granted or mis-reported status must never hide sources the user
 * can actually pick.
 */
export function screenSourcesVerdict({ platform, access, sourceCount, fetchFailed = false }: ScreenSourcesInput): ScreenSourcesVerdict {
    if (sourceCount > 0) return 'sources';
    if (platform !== 'mac') return 'empty';
    if (access === 'not-applicable') return 'empty';
    if (access === 'granted') {
        // Granted but the call blew up: the per-process cached denial. Sending
        // this user back to System Settings would be useless — the toggle is
        // already on; they need a relaunch.
        if (fetchFailed) return 'macos-relaunch-required';
        // Granted and the call succeeded with nothing in it — a different
        // failure (no open windows, wrong `types`) that must not be blamed on
        // permissions.
        return 'empty';
    }
    // 'not-determined' | 'denied' | 'restricted' | 'unknown' all end up here.
    // 'unknown' is what Electron reports when it can't tell; on the macOS
    // versions Electron 43 supports Screen Recording is always required, so an
    // empty/failed list plus an unclear status is far more likely to be the TCC
    // gate than anything else — and the panel we show is advisory, not a block.
    return 'macos-permission-required';
}

/**
 * Whether the user has already actively refused (or is barred by MDM/parental
 * controls). Drives the copy: a refusal can only be undone in System Settings,
 * whereas 'not-determined' may still produce the one-shot system prompt.
 */
export function isScreenAccessRefused(access: ScreenCaptureAccess): boolean {
    return access === 'denied' || access === 'restricted';
}

/**
 * Deep link to System Settings → Privacy & Security → Screen Recording.
 * Hardcoded on purpose: it is passed to `shell.openExternal` in the main
 * process and must never be influenced by the renderer (see the
 * `shell:open-external` https/mailto allowlist, which deliberately does not
 * cover this scheme).
 */
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
