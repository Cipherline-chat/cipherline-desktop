/**
 * quick-share-foreground - "share the window that was in front when I pressed
 * the Quick Screen Share shortcut" (owner report 2026-10-20), the main-process
 * half.
 *
 * ── Why this lives in MAIN ────────────────────────────────────────────────
 * The shortcut is global, so it is usually pressed while ANOTHER program is in
 * front. By the time the renderer hears about it (IPC, a React effect, an async
 * game probe) Cipherline may already have taken focus, and the renderer cannot
 * be trusted to say which window was in front anyway. So main reads the
 * foreground window from the native addon IN THE SHORTCUT CALLBACK (the same
 * place it notes input presence for capture-consent.ts), keeps it for a few
 * seconds, and hands the renderer only the capture SOURCE ID it maps to, after
 * checking that id against its own desktopCapturer window list. The renderer
 * supplies no handle and no id: `share:quick-share-foreground` takes no
 * arguments, so there is nothing for a hostile renderer to make main lie about.
 *
 * The result is a capture source id like any picker pick. It still goes through
 * the normal grant flow (capture:mint-grant -> desktop-capturer-resolve ->
 * audio:start-window-capture); the shortcut press is trusted input to
 * capture-consent.ts, so no native dialog is added.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * Holds one decimal window handle and a boolean for at most FOREGROUND_TTL_MS,
 * in memory. No titles, no program names, nothing written or logged.
 *
 * Deliberately free of any `electron` import (quick-share-foreground.test.ts);
 * main.ts supplies the addon's raw answer and the source list.
 */
import { parseWindowSourceHandle } from './annotation-overlay-target';

/** A captured foreground is only meaningful for the key press that took it. */
export const FOREGROUND_TTL_MS = 5_000;

export interface CapturedForeground {
    /** Decimal root-window handle of the foreground window; null = none / desktop / shell / unknown. */
    hwnd: string | null;
    /** The foreground window belongs to Cipherline itself. */
    isCipherline: boolean;
}

/**
 * What the addon's getForegroundInfo returned, narrowed to what this needs.
 * null = unusable (not an object). An addon built before `fgWindow` existed
 * yields { hwnd: null } - "unknown" - so the caller falls back.
 */
export function readNativeForegroundWindow(raw: unknown): CapturedForeground | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    let hwnd: string | null = null;
    if (typeof r.fgWindow === 'string' && r.fgWindow.length > 0 && r.fgWindow.length <= 20) {
        // Reuse the one HWND parser (digits only, non-zero, within 2^64-1).
        hwnd = parseWindowSourceHandle(`window:${r.fgWindow}:0`);
    }
    return { hwnd, isCipherline: r.fgIsCipherline === true };
}

export interface QuickShareForegroundStore {
    /** Record what is in front RIGHT NOW (anything unusable = unknown). Replaces any earlier capture. */
    capture(raw: unknown): void;
    /** Hand out the capture once; null when there is none, it was already taken, or it is older than the TTL. */
    take(): CapturedForeground | null;
}

export function createQuickShareForegroundStore(deps: { now?: () => number } = {}): QuickShareForegroundStore {
    const now = deps.now ?? Date.now;
    let held: { fg: CapturedForeground | null; at: number } | null = null;
    return {
        capture(raw) {
            // Always overwrite, even with "unknown": an unreadable press must not
            // be answered with an older press's window.
            held = { fg: readNativeForegroundWindow(raw), at: now() };
        },
        take() {
            const h = held;
            held = null;
            if (!h || !h.fg || now() - h.at > FOREGROUND_TTL_MS) return null;
            return h.fg;
        },
    };
}

/** Is there anything worth enumerating windows for? (Cheap pre-check: skips the window list entirely when not.) */
export function hasForegroundCandidate(fg: CapturedForeground | null): fg is CapturedForeground & { hwnd: string } {
    return !!fg && !fg.isCipherline && fg.hwnd !== null;
}

/**
 * The window source that IS the captured foreground window, from main's OWN
 * list. null = fall back: nothing captured, Cipherline itself, desktop / shell /
 * unknown, or that window is not in the list (minimised, cloaked, filtered out
 * by the capturer). Only `window:` sources can match.
 */
export function resolveForegroundSource(fg: CapturedForeground | null, sources: ReadonlyArray<{ id: string }>): string | null {
    if (!hasForegroundCandidate(fg)) return null;
    for (const s of sources) {
        if (typeof s.id === 'string' && s.id.startsWith('window:') && parseWindowSourceHandle(s.id) === fg.hwnd) return s.id;
    }
    return null;
}
