/**
 * Renderer half of the desktop annotation overlay (docs/video-annotation-
 * design.md, Phase 5). While the local user shares a SCREEN, mirror the
 * annotation store's strokes for that share onto a transparent always-on-top
 * window over the real display (electron/annotation-overlay.ts) so the
 * streamer sees viewers' strokes on their actual work.
 *
 * One attachment per share, refcounted: the local share tile can be mounted
 * in more than one layout at once (strip + fullscreen), and the overlay must
 * survive one of them unmounting. Store changes are coalesced per animation
 * frame and sent as deltas — a live stroke only ships its new points, not the
 * whole list on every pointer move.
 *
 * Everything here is best-effort UX on top of the in-app overlay, which
 * remains the source of truth: no Electron bridge (browser, Linux, window
 * share) simply means no desktop overlay.
 */
import { Track } from 'livekit-client';
import { annotationStore, trackKey, type Stroke } from './annotationStore';
import type { OverlayDelta } from './annotationOverlayTypes';
export type { OverlayDelta } from './annotationOverlayTypes';

/**
 * What the overlay already has for one stroke: how many of its points, and
 * whether it had closed. A live stroke's `points` only ever grows now, so
 * `sent` is a plain index into it.
 */
interface Sent { sent: number; closed: boolean }

let refs = 0;
let key = '';
let shown = false;
let unsubscribe: (() => void) | null = null;
let raf: number | null = null;
let generation = 0;
const sent = new Map<string, Sent>();

const toWire = (s: Stroke) => ({
    id: s.id, color: s.color, width: s.width,
    points: s.points.map(p => ({ x: p.x, y: p.y })),
    updatedAt: s.updatedAt, closedAt: s.closedAt,
});

/**
 * Diff the store's strokes for `key` against what the overlay already has.
 *
 * Only NEW points are ever sent: the overlay runs the same watchdog and the
 * same whole-stroke fade on its own clock from the `updatedAt`/`closedAt`
 * stamps it is given, so this never has to narrate a removal — only additions
 * and the eventual whole-stroke `remove` when a track is dropped.
 */
export function diffForOverlay(list: readonly Stroke[], state: Map<string, Sent>): OverlayDelta | null {
    const upsert: NonNullable<OverlayDelta['upsert']> = [];
    const append: NonNullable<OverlayDelta['append']> = [];
    const remove: string[] = [];
    const seen = new Set<string>();
    for (const s of list) {
        seen.add(s.id);
        const total = s.points.length;
        const closed = s.closedAt !== 0;
        const prev = state.get(s.id);
        if (!prev || total < prev.sent) upsert.push(toWire(s)); // new, or genuinely rewound
        else if (total > prev.sent || closed !== prev.closed) {
            append.push({
                id: s.id,
                points: s.points.slice(prev.sent).map(p => ({ x: p.x, y: p.y })),
                updatedAt: s.updatedAt,
                closedAt: s.closedAt,
            });
        }
        state.set(s.id, { sent: total, closed });
    }
    for (const id of [...state.keys()]) {
        if (!seen.has(id)) { remove.push(id); state.delete(id); }
    }
    if (!upsert.length && !append.length && !remove.length) return null;
    const out: OverlayDelta = {};
    if (upsert.length) out.upsert = upsert;
    if (append.length) out.append = append;
    if (remove.length) out.remove = remove;
    return out;
}

// ── Lazy window ──────────────────────────────────────────────────────────────
// The overlay window is created when there is something to draw and torn down
// again once the share has had no strokes for HIDE_AFTER_IDLE_MS — not for
// the whole life of every screen share, as it used to be. A display-sized,
// transparent, always-on-top window costs the compositor something on every
// frame it sits over, and on Windows any window above a fullscreen game takes
// that game out of independent flip into composed presentation (an extra
// frame of latency, and lost frames under GPU load) — exactly the people
// sharing a game at 90 fps, the case the share pipeline is tuned for. Most
// shares are never drawn on at all; those now never create the window.
// The cost of laziness is the first stroke of a burst appearing one window-
// creation later (~0.1–0.3 s); its fade still runs off the stroke's own
// stamps, so it stays in step with the in-app tile.
export const HIDE_AFTER_IDLE_MS = 15_000;
let showing: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let sourceIdCur = '';

function clearIdleTimer(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function hideWindow(): void {
    clearIdleTimer();
    sent.clear();
    if (shown) {
        shown = false;
        void window.electronAPI?.annotationOverlayHide?.();
    }
}

async function showWindow(gen: number): Promise<void> {
    const api = window.electronAPI;
    let ok = false;
    try { ok = !!api?.annotationOverlayShow && await api.annotationOverlayShow(sourceIdCur); } catch { ok = false; }
    if (gen !== generation || refs === 0) {
        // Released (or re-targeted) while the window was being created.
        if (ok) void api?.annotationOverlayHide?.();
        return;
    }
    if (!ok) return;
    shown = true;
    sent.clear();
    // Full state first, then live diffs.
    const list = annotationStore.getState().strokes[key] ?? [];
    api?.annotationOverlayPush?.({ reset: true, ...(diffForOverlay(list, sent) ?? {}) });
}

function flush(): void {
    raf = null;
    if (refs === 0) return;
    const list = annotationStore.getState().strokes[key] ?? [];
    if (list.length > 0) {
        clearIdleTimer();
        if (!shown) {
            if (!showing) {
                const gen = generation;
                showing = showWindow(gen).finally(() => { showing = null; if (gen === generation) schedule(); });
            }
            return;
        }
    } else if (shown && !idleTimer) {
        idleTimer = setTimeout(() => {
            idleTimer = null;
            const now = annotationStore.getState().strokes[key] ?? [];
            if (now.length === 0) hideWindow();
        }, HIDE_AFTER_IDLE_MS);
    }
    if (!shown) return;
    const delta = diffForOverlay(list, sent);
    if (delta) window.electronAPI?.annotationOverlayPush?.(delta);
}

function schedule(): void {
    if (raf != null) return;
    raf = requestAnimationFrame(flush);
}

function start(identity: string, sourceId: string): void {
    if (!window.electronAPI?.annotationOverlayShow) return;
    generation++;
    key = trackKey(identity, Track.Source.ScreenShare);
    sourceIdCur = sourceId;
    sent.clear();
    unsubscribe = annotationStore.subscribe(schedule);
    // Strokes may already exist (drawn on the in-app tile before this attach).
    schedule();
}

function stop(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    hideWindow();
}

/**
 * Keep the desktop overlay alive for the local screen share of `sourceId`.
 * Returns a release function; the overlay hides when the last holder releases.
 * No-op (returns a no-op release) outside Electron or for window shares.
 */
export function attachDesktopAnnotationOverlay(identity: string, sourceId: string): () => void {
    if (!window.electronAPI?.annotationOverlayShow || !sourceId.startsWith('screen:')) return () => {};
    refs++;
    if (refs === 1) start(identity, sourceId);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refs--;
        if (refs === 0) stop();
    };
}
