/**
 * "What has the screen right now?" - the main-process half of the screen-share
 * frame-rate diagnostics and the "share the game window instead" hint.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * Owner report 2026-10-14 (Windows 11, 2560x1440 @ 200 Hz, sharing the whole
 * screen at 90 fps): game focused -> the share falls to ~9 fps; Cipherline
 * focused with the game still visible -> 45-80 fps. Two focus-dependent
 * causes are on the table:
 *   (A) Windows power throttling of a background process (share-boost.ts,
 *       PowerThrottleOptOut), and
 *   (B) the game's fullscreen / independent-flip presentation, which bypasses
 *       DWM composition while the game is in front, so a whole-SCREEN capture
 *       only receives occasional frames.
 * (B) cannot be fixed from our side for a screen capture, only detected, and
 * a WINDOW capture of the game is not affected by it. So every `share_fps` /
 * `share_background` event now says what was in front (fg_state / fg_exe /
 * fg_cover), and the renderer offers to share the game's window instead.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * The addon (share_power.cc getForegroundInfo) reports the Windows
 * notification state enum, the foreground process's image BASENAME (never a
 * path), whether that window's rectangle equals its monitor's, and whether it
 * is ours. No window titles, no handles. The basename is a program name, like
 * the game detector already uses; it only ever sits in the in-memory call
 * event log and a report the user chooses to send.
 *
 * Deliberately free of any `electron` import so every decision is unit
 * testable (share-foreground.test.ts); main.ts supplies the addon and the
 * display count.
 */
import type { Rect } from './annotation-overlay-target';
import { cleanRect, parseScreenSourceIndex, parseWindowSourceHandle } from './annotation-overlay-target';
import { shareBoostSupport } from './share-platform';

/**
 * What `share:get-foreground-info` answers where there is NO foreground
 * information to give (Linux, macOS — see ./share-platform.ts for why). A
 * distinct, explicit marker instead of null so the call events can say
 * `fg_state: "unavailable"` rather than leaving the field blank, which would be
 * indistinguishable from "asked and the addon failed". Carries nothing else:
 * no program, no rectangle, no guess.
 */
export interface ForegroundUnavailable { unavailable: true }

/**
 * The platform's answer when the addon is not the one answering:
 *   - a platform with no foreground support at all -> { unavailable: true };
 *   - Windows (support is 'native'): null here — the addon (or its absence) decides;
 *   - an unknown platform -> null.
 */
export function foregroundAnswerWithoutAddon(platform: string): ForegroundUnavailable | null {
    if (platform !== 'linux' && platform !== 'darwin') return null;
    return shareBoostSupport(platform).foreground === 'unavailable' ? { unavailable: true } : null;
}

/** SHQueryUserNotificationState's values, by name. Anything else is reported as QUNS_UNKNOWN. */
export const NOTIFICATION_STATES: readonly string[] = Object.freeze([
    'QUNS_NOT_PRESENT',
    'QUNS_BUSY',
    'QUNS_RUNNING_D3D_FULL_SCREEN',
    'QUNS_PRESENTATION_MODE',
    'QUNS_ACCEPTS_NOTIFICATIONS',
    'QUNS_QUIET_TIME',
    'QUNS_APP',
    'QUNS_UNKNOWN',
]);

/** What the renderer gets: no rectangles, no handles, no titles. */
export interface ForegroundInfo {
    notificationState: string;
    /** Basename of the foreground window's process image ('' = unreadable / none). */
    fgExe: string;
    /** The foreground window's rectangle equals the rectangle of the monitor it is on. */
    fgCoversMonitor: boolean;
    /** The foreground window belongs to Cipherline. */
    fgIsCipherline: boolean;
    /**
     * The foreground window's monitor IS the monitor the shared SCREEN captures.
     * null = cannot tell (not a screen share, no addon rectangle, several displays).
     */
    onSharedScreen: boolean | null;
}

const MAX_EXE = 48;

/**
 * A program name fit for the call event log: a basename only (any path part is
 * dropped), letters, digits and `. _ - + ( )` and spaces, at most 48 chars;
 * '' for anything else. Never throws.
 */
export function cleanExeName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const base = raw.split(/[\\/]/).pop() ?? '';
    const trimmed = base.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_EXE) return '';
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
    if (/[\u0000-\u001f]/.test(trimmed)) return '';
    return /^[A-Za-z0-9._ +()-]+$/.test(trimmed) ? trimmed : '';
}

/** What the addon's getForegroundInfo returns, validated. null = unusable. */
export function cleanNativeForeground(raw: unknown): (Omit<ForegroundInfo, 'onSharedScreen'> & { monitor: Rect | null }) | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const state = typeof r.notificationState === 'string' && NOTIFICATION_STATES.includes(r.notificationState)
        ? r.notificationState
        : 'QUNS_UNKNOWN';
    return {
        notificationState: state,
        fgExe: cleanExeName(r.fgExe),
        fgCoversMonitor: r.fgCoversMonitor === true,
        fgIsCipherline: r.fgIsCipherline === true,
        monitor: cleanRect(r.fgMonitor),
    };
}

/** Two physical monitor rectangles are "the same monitor" within a couple of pixels. */
export function sameMonitorRect(a: Rect, b: Rect, tolerance = 2): boolean {
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
        && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

/**
 * The renderer's request: the share's source id (or nothing). A trust
 * boundary - only a `screen:` / `window:` capture source id, or null.
 */
export function validateForegroundRequest(input: unknown): string | null {
    if (input === undefined || input === null) return null;
    if (typeof input !== 'string' || input.length > 64) throw new Error('share:get-foreground-info: expected a source id string');
    if (parseScreenSourceIndex(input) === null && parseWindowSourceHandle(input) === null) {
        throw new Error('share:get-foreground-info: not a capture source id');
    }
    return input;
}

/**
 * Join the addon's answer with the share's monitor.
 *
 * `sharedScreenRect` is the physical rectangle of the shared `screen:<n>:0`
 * source (window_geometry.cc getScreenRectFromDeviceIndex), null when it is
 * unknown. With no rectangle, a single display is still unambiguous; several
 * displays are not, and the answer is null ("cannot tell"), never a guess.
 */
export function describeForeground(opts: {
    raw: unknown;
    sourceId: string | null;
    sharedScreenRect: Rect | null;
    displayCount: number;
}): ForegroundInfo | null {
    const native = cleanNativeForeground(opts.raw);
    if (!native) return null;
    let onSharedScreen: boolean | null = null;
    if (opts.sourceId !== null && parseScreenSourceIndex(opts.sourceId) !== null) {
        if (opts.sharedScreenRect && native.monitor) onSharedScreen = sameMonitorRect(opts.sharedScreenRect, native.monitor);
        else if (opts.displayCount === 1) onSharedScreen = true;
    }
    return {
        notificationState: native.notificationState,
        fgExe: native.fgExe,
        fgCoversMonitor: native.fgCoversMonitor,
        fgIsCipherline: native.fgIsCipherline,
        onSharedScreen,
    };
}

// ── Picking the game's window in the picker ────────────────────────────────

export const MAX_WINDOW_SOURCE_IDS = 256;

/** The renderer's `share:find-window-source` request, validated. */
export function validateFindWindowRequest(exe: unknown, ids: unknown): { exe: string; ids: string[] } {
    const name = cleanExeName(exe);
    if (!name) throw new Error('share:find-window-source: expected a program name');
    if (!Array.isArray(ids) || ids.length > MAX_WINDOW_SOURCE_IDS) throw new Error('share:find-window-source: expected a list of window source ids');
    const clean: string[] = [];
    for (const id of ids) {
        if (typeof id !== 'string' || id.length > 64 || parseWindowSourceHandle(id) === null) {
            throw new Error('share:find-window-source: not a window source id');
        }
        clean.push(id);
    }
    return { exe: name, ids: clean };
}

export interface WindowCandidate {
    id: string;
    /** The window's process basename, '' when unreadable. */
    exe: string;
    /** The window's visible area in px (0 = unknown). */
    area: number;
    /** Visible and not minimised. */
    usable: boolean;
}

/**
 * The window source to pre-select for a game: the usable window(s) of that
 * program (case-insensitive), the largest one winning. Several windows of one
 * program are normal (a launcher, a splash); the game itself is the big one.
 * null = no match - the picker then just opens on the Window tab.
 */
export function pickWindowByExe(candidates: readonly WindowCandidate[], exe: string): string | null {
    const want = exe.toLowerCase();
    if (!want) return null;
    let best: WindowCandidate | null = null;
    for (const c of candidates) {
        if (!c.usable || c.exe.toLowerCase() !== want) continue;
        if (!best || c.area > best.area) best = c;
    }
    return best ? best.id : null;
}
