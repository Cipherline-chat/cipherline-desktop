/**
 * A WINDOW share that Windows will not capture (report: a game window - World of
 * Warcraft - failed with AbortError the moment the share started; the whole
 * screen shared fine; stable 0.1.2).
 *
 * ── Where an AbortError at share start comes from (Electron 43 / Chromium 150) ──
 * Read out of the sources (third_party/blink/.../user_media_request.cc and
 * electron/shell/browser/electron_browser_context.cc):
 *   • kAbortError is what getDisplayMedia rejects with for INVALID_STATE,
 *     START_TIMEOUT ("Timeout starting video source") and
 *     INVALID_DISPLAY_CAPTURE_CONSTRAINTS, among others.
 *   • Electron answers INVALID_DISPLAY_CAPTURE_CONSTRAINTS when our
 *     setDisplayMediaRequestHandler callback is called with null - i.e. main's
 *     `desktop-capturer-resolve` REFUSED the source (not in the list any more,
 *     consent declined, an error). Main reports which (`resolve_refused`).
 *   • START_TIMEOUT is the renderer's 10 s kCaptureStartTimeout: the capture
 *     device never reported started.
 *   • A device that cannot open the window at all (WGC refuses it AND
 *     Chromium's own cropping/GDI fallback - kWebRtcWgcWindowCroppingFallback -
 *     refuses it too, e.g. a MINIMISED window) is NotReadableError ("Could not
 *     start video source"); a capturer that fails permanently after starting
 *     ends the track instead.
 * A full-screen game is the textbook case for all of them: exclusive
 * fullscreen MINIMISES the game the moment Cipherline is clicked (no window
 * capturer can capture a minimised window), its swap chain is recreated on a
 * mode switch (the HWND the picker listed can be gone or re-created), and a
 * window capture of a flip-model swap chain can hand WGC no frames at all.
 * The Pro difference the user noticed is the capture ASK (a 4K / 'source' box
 * at 75 capture fps instead of 1080p30): it changes nothing about whether WGC
 * can open the window, but it is the one input that differs, so the ladder's
 * first retry drops it.
 *
 * ── What a failed window capture does now (this module decides; SidebarConference runs it) ──
 *   1. 'safe'          - the same window again, after a short pause, asking for
 *                        at most 1080p30 (safeWindowCapture).
 *   2. 'monitor_crop'  - capture the MONITOR the window is on and crop it to the
 *                        window (planMonitorCrop), the window's own audio kept.
 *                        Only when the window is on screen and not minimised.
 *   3. 'offer_screen'  - tell the user why, and offer "Share the whole screen
 *                        instead" (never a silent failure).
 * A refusal by the USER (NotAllowedError, the consent dialog declined) is never
 * routed around: 'give_up' with the ordinary message.
 *
 * Pure: no React, no LiveKit, no Electron. Unit tested (windowShareFallback.test.ts).
 * Privacy: nothing here ever sees or logs a window title; the log details are
 * fixed words, booleans and integers.
 */
import type { RegionLayout } from './shareLayout';

export interface Rect { x: number; y: number; width: number; height: number }

/** What main reports about the shared window (src-native/window_geometry.cc getWindowInfo, validated). */
export interface WindowState {
    exists: boolean;
    visible: boolean;
    minimized: boolean;
    cloaked: boolean;
    /** Physical pixels (DWMWA_EXTENDED_FRAME_BOUNDS). */
    frame: Rect | null;
}

/** A screen capture source and the physical rectangle of the monitor it captures. */
export interface ScreenRect { sourceId: string; rect: Rect }

export interface WindowGeometry {
    window: WindowState | null;
    screens: ScreenRect[];
}

export type CaptureFailureClass =
    /** main's resolve refused the source (Electron then rejects with AbortError). */
    | 'refused'
    /** The user declined (consent dialog, or its cooldown) - never routed around. */
    | 'declined'
    /** NotAllowedError: refused by the user / OS. */
    | 'denied'
    /** NotFoundError: the source is gone. */
    | 'not_found'
    /** START_TIMEOUT: the capturer never reported started within 10 s. */
    | 'timeout'
    /** NotReadableError "Could not start video source": the capturer could not open it. */
    | 'start_failed'
    /** Any other AbortError. */
    | 'aborted'
    /** NotReadableError with another message (device in use, ...). */
    | 'unreadable'
    /** OverconstrainedError / TypeError: the constraints were rejected. */
    | 'constraints'
    /** The capture opened, then ended before its first frame (a capturer that failed permanently after starting). */
    | 'ended'
    | 'other';

export interface CaptureFailure {
    /** The DOMException name, sanitised (never the message). */
    name: string;
    cls: CaptureFailureClass;
}

/** The name of the error a window capture that ended before its first frame is reported as (captureEndedError). */
export const CAPTURE_ENDED_ERROR = 'CaptureEndedError';

/**
 * Chromium reports a capturer that fails permanently AFTER starting by ending
 * the track, not by rejecting getDisplayMedia: the share would publish a dead
 * track. Thrown instead, so the fallback ladder sees it like any other failure.
 */
export function captureEndedError(): Error {
    const e = new Error('The capture ended before its first frame');
    e.name = CAPTURE_ENDED_ERROR;
    return e;
}

// Chromium's fixed messages (user_media_processor.cc ErrorCodeToString). Matched, never logged.
const MSG_TIMEOUT = 'Timeout starting video source';
const MSG_START_FAILED = 'Could not start video source';

/**
 * Classify a capture failure. `resolveOutcome` is what main's
 * desktop-capturer-resolve answered for this attempt ('ok', 'no_source',
 * 'denied_declined', ...), when the renderer saw it.
 */
export function classifyCaptureFailure(err: unknown, resolveOutcome?: string | null): CaptureFailure {
    const e = err as { name?: unknown; message?: unknown } | null;
    const rawName = typeof e?.name === 'string' ? e.name : 'unknown';
    const name = rawName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'unknown';
    const message = typeof e?.message === 'string' ? e.message : '';
    if (resolveOutcome && resolveOutcome !== 'ok') {
        if (resolveOutcome === 'cancelled' || resolveOutcome.startsWith('denied')) return { name, cls: 'declined' };
        return { name, cls: 'refused' };
    }
    switch (rawName) {
        case 'NotAllowedError': return { name, cls: 'denied' };
        case 'NotFoundError': return { name, cls: 'not_found' };
        case 'OverconstrainedError':
        case 'TypeError': return { name, cls: 'constraints' };
        case 'AbortError': return { name, cls: message.includes(MSG_TIMEOUT) ? 'timeout' : 'aborted' };
        case 'NotReadableError': return { name, cls: message.includes(MSG_START_FAILED) ? 'start_failed' : 'unreadable' };
        case CAPTURE_ENDED_ERROR: return { name, cls: 'ended' };
        default: return { name, cls: 'other' };
    }
}

/** Does this share get the window fallback ladder at all? */
export function windowFallbackEligible(i: {
    sourceId: string;
    platform: string | undefined;
    /** Linux Wayland portal capture: no window ids, the desktop chooses. */
    viaPortal: boolean;
    /** A single-screen crop of an ultra-wide display (never a window). */
    slice: boolean;
    /** The capture was reused / carried, not asked for (a failure there is not the capturer's). */
    reused: boolean;
}): boolean {
    return i.platform === 'win' && i.sourceId.startsWith('window:') && !i.viaPortal && !i.slice && !i.reused;
}

export type WindowShareStep = 'as_asked' | 'safe' | 'monitor_crop' | 'offer_screen' | 'give_up';

/**
 * The step after `prev` failed with `failure`. `win` is the window's state
 * right after the failure (null = unknown: no addon, older main).
 */
export function nextWindowShareStep(prev: WindowShareStep, failure: CaptureFailureClass, win: WindowState | null): WindowShareStep {
    // The user said no: never route around it.
    if (failure === 'declined' || failure === 'denied') return 'give_up';
    // The window is gone (closed, or the game re-created it): nothing of it to capture.
    if (win && !win.exists) return 'give_up';
    switch (prev) {
        case 'as_asked':
            // A minimised (exclusive-fullscreen game after alt-tab) or cloaked window
            // cannot be captured by any window capturer, nor seen on its monitor.
            if (win && (win.minimized || win.cloaked)) return 'offer_screen';
            return 'safe';
        case 'safe':
            return 'monitor_crop';
        case 'monitor_crop':
            return 'offer_screen';
        default:
            return 'give_up';
    }
}

/** The ladder's 'safe' ask: the same window, at most 1080p30. */
export const SAFE_WINDOW_BOX = { width: 1920, height: 1080 } as const;
export const SAFE_WINDOW_FPS = 30;
/** Pause before the 'safe' retry: the OS capturer letting go of the failed attempt (shareCaptureRetry.ts). */
export const WINDOW_RETRY_DELAY_MS = 400;

export function safeWindowCapture(box: { width: number; height: number }, captureFps: number): { box: { width: number; height: number }; fps: number } {
    return {
        box: { width: Math.min(box.width, SAFE_WINDOW_BOX.width), height: Math.min(box.height, SAFE_WINDOW_BOX.height) },
        fps: Math.min(captureFps, SAFE_WINDOW_FPS),
    };
}

/** At least this much of the window must be on one monitor for the monitor crop. */
export const MIN_WINDOW_ON_MONITOR = 0.5;
/** A window covering this much of its monitor is "fullscreen" (diagnostics, and the notice's wording). */
export const FULLSCREEN_COVERAGE = 0.98;
/** Smallest window side (physical px) worth cropping to. */
export const MIN_CROP_SIDE_PX = 64;

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const validRect = (r: Rect | null | undefined): r is Rect =>
    !!r && fin(r.x) && fin(r.y) && fin(r.width) && fin(r.height) && r.width > 0 && r.height > 0;

function intersect(a: Rect, b: Rect): Rect | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The screen the window is (mostly) on, with the overlap. null when none holds any of it. */
export function pickScreenForWindow(frame: Rect | null | undefined, screens: readonly ScreenRect[]): { screen: ScreenRect; overlap: Rect } | null {
    if (!validRect(frame)) return null;
    let best: { screen: ScreenRect; overlap: Rect } | null = null;
    for (const s of screens) {
        if (!validRect(s.rect)) continue;
        const o = intersect(frame, s.rect);
        if (!o) continue;
        if (!best || o.width * o.height > best.overlap.width * best.overlap.height) best = { screen: s, overlap: o };
    }
    return best;
}

export interface MonitorCropPlan {
    /** The screen source to capture. */
    screenSourceId: string;
    /** The window's visible part, as fractions of that screen (the crop). */
    region: RegionLayout;
    /** The window covers (nearly) its whole monitor. */
    fullscreen: boolean;
}

/**
 * Capture the window's monitor and crop it to the window: feasible when the
 * window is on screen (visible, not minimised or cloaked) and at least half of
 * it is on one monitor. The crop is the part of the window on that monitor.
 */
export function planMonitorCrop(geo: WindowGeometry | null): MonitorCropPlan | null {
    const win = geo?.window;
    if (!win || !win.exists || !win.visible || win.minimized || win.cloaked || !validRect(win.frame)) return null;
    const hit = pickScreenForWindow(win.frame, geo!.screens);
    if (!hit) return null;
    const { screen, overlap } = hit;
    if (overlap.width * overlap.height < MIN_WINDOW_ON_MONITOR * win.frame.width * win.frame.height) return null;
    if (overlap.width < MIN_CROP_SIDE_PX || overlap.height < MIN_CROP_SIDE_PX) return null;
    const s = screen.rect;
    const region: RegionLayout = {
        kind: 'region',
        x: (overlap.x - s.x) / s.width,
        y: (overlap.y - s.y) / s.height,
        w: overlap.width / s.width,
        h: overlap.height / s.height,
    };
    return {
        screenSourceId: screen.sourceId,
        region,
        fullscreen: overlap.width * overlap.height >= FULLSCREEN_COVERAGE * s.width * s.height,
    };
}

/** Has the window moved enough that the crop should follow? (Half a percent of the monitor, either way.) */
export function regionMoved(a: RegionLayout, b: RegionLayout): boolean {
    const d = 0.005;
    return Math.abs(a.x - b.x) > d || Math.abs(a.y - b.y) > d || Math.abs(a.w - b.w) > d || Math.abs(a.h - b.h) > d;
}

/** How often a monitor-cropped share re-reads the window's position. */
export const CROP_FOLLOW_INTERVAL_MS = 1_000;

/**
 * The screen the "Share the whole screen instead" offer shares: the window's
 * monitor when known, else the first screen listed (main lists the primary first).
 */
export function screenForOffer(geo: WindowGeometry | null): string | null {
    const hit = pickScreenForWindow(geo?.window?.frame ?? null, geo?.screens ?? []);
    if (hit) return hit.screen.sourceId;
    return geo?.screens.find(s => s.sourceId.startsWith('screen:'))?.sourceId ?? null;
}

/** The notice for a window the ladder could not capture (no title: the user knows what they picked). */
export function windowCaptureFailedText(win: WindowState | null, canOfferScreen: boolean): string {
    const tail = canOfferScreen ? ' You can share the whole screen instead.' : ' Try sharing the whole screen instead.';
    if (win && win.minimized) {
        return 'Windows can’t capture that window while it’s minimized. Games in exclusive fullscreen minimize when you click away - switch the game to borderless / “Windowed (Fullscreen)” mode.' + tail;
    }
    if (win && win.cloaked) return 'That window is on another virtual desktop, so Windows can’t capture it.' + tail;
    return 'Windows wouldn’t let Cipherline capture that window (games running in fullscreen often block it).' + tail;
}

/** Shown while a monitor-cropped share runs: what it is, and what else may show. */
export const MONITOR_CROP_NOTICE =
    'Windows wouldn’t capture that window directly, so Cipherline is sharing its part of the screen instead. Anything you move on top of it will be visible.';

/**
 * The `share_window_fallback` call-event details. Keys <= 31 chars, lowercase
 * (callEventLog KEY_RE); fixed words, booleans and integers only.
 */
export function fallbackEventDetails(i: {
    /** The step that just failed. */
    from: WindowShareStep;
    /** What is tried next. */
    to: WindowShareStep;
    failure: CaptureFailure;
    win: WindowState | null;
    fullscreen?: boolean;
    resolve?: string | null;
}): Record<string, string | number | boolean> {
    const d: Record<string, string | number | boolean> = {
        from: i.from,
        to: i.to,
        why: i.failure.name,
        cls: i.failure.cls,
        win_known: !!i.win,
    };
    if (i.win) {
        d.win_exists = i.win.exists;
        d.win_min = i.win.minimized;
        d.win_vis = i.win.visible;
        d.win_cloaked = i.win.cloaked;
    }
    if (i.fullscreen !== undefined) d.fullscreen = i.fullscreen;
    if (i.resolve) d.resolve = i.resolve.replace(/[^a-z0-9_]/gi, '').slice(0, 30);
    return d;
}

/** Validate what main's `screen-share:window-geometry` answered (never trusted blindly). */
export function parseWindowGeometry(raw: unknown): WindowGeometry | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const rect = (v: unknown): Rect | null => {
        if (!v || typeof v !== 'object') return null;
        const o = v as Record<string, unknown>;
        const c = { x: o.x, y: o.y, width: o.width, height: o.height } as Rect;
        return validRect(c) ? { x: c.x, y: c.y, width: c.width, height: c.height } : null;
    };
    let window: WindowState | null = null;
    if (r.window && typeof r.window === 'object') {
        const w = r.window as Record<string, unknown>;
        window = {
            exists: w.exists === true,
            visible: w.visible === true,
            minimized: w.minimized === true,
            cloaked: w.cloaked === true,
            frame: rect(w.frame),
        };
    }
    const screens: ScreenRect[] = [];
    if (Array.isArray(r.screens)) {
        for (const s of r.screens.slice(0, 16)) {
            if (!s || typeof s !== 'object') continue;
            const o = s as Record<string, unknown>;
            const sr = rect(o.rect);
            if (typeof o.sourceId === 'string' && /^screen:[A-Za-z0-9_.:-]{1,80}$/.test(o.sourceId) && sr) screens.push({ sourceId: o.sourceId, rect: sr });
        }
    }
    return { window, screens };
}

/** What the ladder needs from the share start (SidebarConference supplies these; tests supply fakes). */
export interface WindowFallbackDeps {
    /** What main's resolve answered for the attempt that just failed (null = unknown). */
    resolveOutcome(): Promise<string | null>;
    /** The window's state and the screens holding it, read after each failure (null = unknown). */
    geometry(): Promise<WindowGeometry | null>;
    /** Can frames be cropped here (WebCodecs breakout box)? */
    cropSupported: boolean;
    /** The 'safe' attempt: the same window at <= 1080p30. Throws on failure. */
    attemptSafe(): Promise<void>;
    /** The 'monitor_crop' attempt. Throws on failure. */
    attemptCrop(plan: MonitorCropPlan): Promise<void>;
    /** Called when an attempt failed, before the next step (release whatever it left behind). */
    cleanup(): void;
    /** One row per decision (share_window_fallback) and a console line (fixed words only). */
    log(details: Record<string, string | number | boolean>, line: string): void;
    sleep(ms: number): Promise<void>;
}

export type WindowFallbackResult =
    | { kind: 'published'; via: 'safe' | 'monitor_crop'; plan: MonitorCropPlan | null }
    /** Offer the whole screen (screenId null: none known). */
    | { kind: 'offer_screen'; failure: CaptureFailure; win: WindowState | null; screenId: string | null }
    /** The user said no, or the window is gone: the ordinary failure for `err`. */
    | { kind: 'give_up'; err: unknown };

/**
 * Run the ladder after the first (as-asked) capture of a window failed with
 * `firstErr`. Never throws; every path ends published, offering the screen,
 * or giving up with the error to report.
 */
export async function runWindowFallbackLadder(firstErr: unknown, deps: WindowFallbackDeps): Promise<WindowFallbackResult> {
    let step: WindowShareStep = 'as_asked';
    let err: unknown = firstErr;
    for (;;) {
        let resolve: string | null = null;
        try { resolve = await deps.resolveOutcome(); } catch { resolve = null; }
        const failure = classifyCaptureFailure(err, resolve);
        let geo: WindowGeometry | null = null;
        try { geo = await deps.geometry(); } catch { geo = null; }
        const win = geo?.window ?? null;
        let next = nextWindowShareStep(step, failure.cls, win);
        let plan: MonitorCropPlan | null = null;
        if (next === 'monitor_crop') {
            plan = deps.cropSupported ? planMonitorCrop(geo) : null;
            if (!plan) next = 'offer_screen';
        }
        deps.log(
            fallbackEventDetails({ from: step, to: next, failure, win, fullscreen: plan?.fullscreen, resolve }),
            `window capture failed (${failure.name}/${failure.cls}${resolve && resolve !== 'ok' ? `, main: ${resolve}` : ''}) after '${step}' -> '${next}'`,
        );
        if (next === 'give_up') return { kind: 'give_up', err };
        if (next === 'offer_screen') return { kind: 'offer_screen', failure, win, screenId: screenForOffer(geo) };
        step = next;
        try {
            if (next === 'safe') {
                await deps.sleep(WINDOW_RETRY_DELAY_MS);
                await deps.attemptSafe();
                return { kind: 'published', via: 'safe', plan: null };
            }
            await deps.attemptCrop(plan!);
            return { kind: 'published', via: 'monitor_crop', plan };
        } catch (e) {
            try { deps.cleanup(); } catch { /* best effort */ }
            err = e;
        }
    }
}
