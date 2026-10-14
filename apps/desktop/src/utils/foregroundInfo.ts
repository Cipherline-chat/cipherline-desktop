/**
 * What has the screen right now - the renderer's view of main's
 * `share:get-foreground-info` (electron/share-foreground.ts, Windows only).
 *
 * It lets every `share_fps` / `share_background` call event say whether a
 * fullscreen game was in front when the frame rate fell (fg_state / fg_exe /
 * fg_cover), and drives the "share the game window instead" hint
 * (shareFullscreenHint.ts). Owner report 2026-10-14: game focused -> the
 * share drops to ~9 fps; Cipherline focused with the game still visible ->
 * 45-80 fps. A fullscreen / independent-flip game bypasses DWM composition, so
 * a whole-SCREEN capture only gets occasional frames; the report now says so.
 *
 * Windows only has an answer. Linux and macOS get main's explicit
 * `{ unavailable: true }`, which becomes `state: "unavailable"` here (see
 * electron/share-platform.ts for why nothing more is attempted there).
 *
 * Privacy: a Windows notification-state enum, a PROGRAM basename and two
 * booleans. No window titles, no handles - main never sends them. Everything
 * is validated here again: whatever crossed the bridge is untrusted.
 */

export interface ForegroundDiag {
    /** SHQueryUserNotificationState as its enum name, e.g. QUNS_RUNNING_D3D_FULL_SCREEN. */
    state: string;
    /** The foreground program's basename ('' = unknown). */
    exe: string;
    /** Its window's rectangle equals its monitor's. */
    covers: boolean;
    /** The foreground window is Cipherline's own. */
    isCipherline: boolean;
    /** It is on the monitor the shared SCREEN captures (null = cannot tell). */
    onSharedScreen: boolean | null;
}

/** `state` for a platform that cannot say what has the screen (Linux, macOS). */
export const FOREGROUND_UNAVAILABLE_STATE = 'unavailable';

const STATE_RE = /^QUNS_[A-Z0-9_]{1,40}$/;
const EXE_RE = /^[A-Za-z0-9._ +()-]{1,48}$/;

/** Narrow main's answer; null = unusable (off Windows, an older main, nonsense). */
export function cleanForegroundDiag(raw: unknown): ForegroundDiag | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    // Main's explicit "there is nothing to ask on this OS" (Linux, macOS).
    if (r.unavailable === true) return unavailableForegroundDiag();
    return {
        state: typeof r.notificationState === 'string' && STATE_RE.test(r.notificationState) ? r.notificationState : 'QUNS_UNKNOWN',
        exe: typeof r.fgExe === 'string' && EXE_RE.test(r.fgExe) ? r.fgExe : '',
        covers: r.fgCoversMonitor === true,
        isCipherline: r.fgIsCipherline === true,
        onSharedScreen: typeof r.onSharedScreen === 'boolean' ? r.onSharedScreen : null,
    };
}

/** The answer on a platform with no foreground information: nothing known, nothing guessed. */
export function unavailableForegroundDiag(): ForegroundDiag {
    return { state: FOREGROUND_UNAVAILABLE_STATE, exe: '', covers: false, isCipherline: false, onSharedScreen: null };
}

export const isForegroundUnavailable = (fg: ForegroundDiag | null): boolean =>
    fg !== null && fg.state === FOREGROUND_UNAVAILABLE_STATE;

/**
 * The `fg_state` / `fg_exe` / `fg_cover` fields of a share_fps /
 * share_background call event. null (no answer: browser build, older main, the
 * share ended) leaves them blank, which the event log drops; "unavailable"
 * writes fg_state alone — fg_cover would otherwise log a false that reads as
 * "a fullscreen game is NOT covering the screen".
 */
export function foregroundLogFields(fg: ForegroundDiag | null): { fg_state: string; fg_exe: string; fg_cover: boolean | '' } {
    if (!fg) return { fg_state: '', fg_exe: '', fg_cover: '' };
    if (isForegroundUnavailable(fg)) return { fg_state: FOREGROUND_UNAVAILABLE_STATE, fg_exe: '', fg_cover: '' };
    return { fg_state: fg.state, fg_exe: fg.exe, fg_cover: fg.covers };
}

type ForegroundApi = { getShareForegroundInfo?: (sourceId?: string) => Promise<unknown> };

/**
 * Ask main what is in front. Never throws; null when there is no answer
 * (browser build, non-Windows, an older main, the share ended mid-call).
 */
export async function fetchForegroundDiag(
    sourceId: string | undefined,
    api: ForegroundApi | undefined = (typeof window !== 'undefined' ? window.electronAPI : undefined) as ForegroundApi | undefined,
): Promise<ForegroundDiag | null> {
    if (!api?.getShareForegroundInfo) return null;
    try { return cleanForegroundDiag(await api.getShareForegroundInfo(sourceId)); } catch { return null; }
}
