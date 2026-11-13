/**
 * Renderer half of the desktop annotation overlay (docs/video-annotation-
 * design.md, Phase 5). While the local user shares a SCREEN or a WINDOW,
 * mirror the annotation store's strokes for that share onto a transparent
 * window over the real display / the shared window
 * (electron/annotation-overlay.ts) so the streamer sees viewers' strokes on
 * their actual work.
 *
 * One attachment per share, refcounted. It is held by SidebarConference for
 * the whole life of the local share — NOT by the self-view tile, which
 * unmounts whenever you focus your own share (the focused stage renders a
 * different tile) or its portal target goes away: the desktop overlay used to
 * die with it, exactly while the streamer was looking at the strokes. Store
 * changes are coalesced (see `schedule` — deliberately NOT per animation
 * frame) and sent as deltas — a live stroke only ships its new points, not the
 * whole list on every pointer move.
 *
 * Everything here is best-effort UX on top of the in-app overlay, which
 * remains the source of truth. When main refuses (no bridge, an unknown
 * display, a window share on Linux, Wayland...) the refusal reason is
 * recorded as an `annot_overlay` call event — once per share and reason —
 * and the next attempt waits REFUSED_RETRY_MS instead of re-asking on every
 * store change.
 */
import { Track } from 'livekit-client';
import { annotationStore, trackKey, type Stroke } from './annotationStore';
import type { OverlayDelta, OverlayShowResult, OverlayScreenChoice, OverlayRect } from './annotationOverlayTypes';
import {
    buildShowHint, loadRememberedScreen, saveRememberedScreen, preselectFromMemory,
    type OverlayShareFacts,
} from './screenChoiceMemory';
import { logCallEvent } from './callEventLog';
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
/** A flush is queued (see `schedule`). */
let flushPending = false;
let flushChannel: MessageChannel | null = null;
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

/** Capture source kinds the main process may be able to overlay. */
export function isOverlayableSourceId(sourceId: string): boolean {
    return sourceId.startsWith('screen:') || sourceId.startsWith('window:');
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
/** The shared frame's size, read when the overlay is (re)shown — see attachDesktopAnnotationOverlay. */
let frameGetter: (() => { width: number; height: number } | null) | null = null;
/** What the share's portal said about the stream (native hardware share), read each time the overlay is shown. */
let factsGetter: (() => OverlayShareFacts | null) | null = null;
const factsNow = (): OverlayShareFacts | null => { try { return factsGetter?.() ?? null; } catch { return null; } };

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

/**
 * After a refusal, how long before asking main again. A refusal is almost
 * always stable for the life of the share (wrong platform, unknown display,
 * Wayland), and asking on every store change made it a tight IPC loop — each
 * round trip a source-list lookup in main — for as long as anyone drew.
 */
export const REFUSED_RETRY_MS = 5_000;
let retryAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Outcomes already logged for this attachment (one event per outcome). */
const logged = new Set<string>();

/** A main process older than OverlayShowResult answers a bare boolean. */
export function normalizeShowResult(raw: unknown): OverlayShowResult {
    if (raw === true) return { ok: true, how: 'unknown', captured: false };
    if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        if (r.ok === true) {
            return { ok: true, how: typeof r.how === 'string' ? r.how.slice(0, 32) : 'unknown', captured: r.captured === true };
        }
        if (r.ok === false && typeof r.reason === 'string') {
            return {
                ok: false,
                reason: r.reason.slice(0, 32) as Extract<OverlayShowResult, { ok: false }>['reason'],
                ...(typeof r.displays === 'number' ? { displays: r.displays } : {}),
                ...(typeof r.addon === 'boolean' ? { addon: r.addon } : {}),
                ...(cleanScreenChoice(r.choice) ? { choice: cleanScreenChoice(r.choice)! } : {}),
            };
        }
    }
    return { ok: false, reason: 'create_failed' };
}

/** Validate the choice main sent (own process, but the renderer still never trusts a shape it did not check). */
export function cleanScreenChoice(raw: unknown): OverlayScreenChoice | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.displays) || !Array.isArray(r.candidates)) return null;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
    const displays: OverlayScreenChoice['displays'] = [];
    for (const d of r.displays.slice(0, 16)) {
        if (!d || typeof d !== 'object') return null;
        const o = d as Record<string, unknown>;
        if (!num(o.id) || !num(o.x) || !num(o.y) || !num(o.width) || !num(o.height) || o.width <= 0 || o.height <= 0) return null;
        displays.push({ id: o.id, x: o.x, y: o.y, width: o.width, height: o.height, primary: o.primary === true });
    }
    const ids = new Set(displays.map(d => d.id));
    const candidates = r.candidates.filter((c): c is number => typeof c === 'number' && ids.has(c));
    // A question with fewer than two answers is not a question.
    return displays.length >= 2 && candidates.length >= 2 ? { displays, candidates } : null;
}

// ── "Which screen are you sharing?" ──────────────────────────────────────────
// On Wayland the portal never says which monitor was picked. When two monitors are
// indistinguishable by size, main asks (needs_choice); the sharer answers once per share and
// the answer is remembered until the share's attachment ends. Declining keeps the in-app preview
// and records WHY the desktop overlay is off, so the viewer is told instead of left guessing.
export type OverlayStatus =
    | { kind: 'idle' }
    /** Waiting for the sharer to pick a screen. */
    /** `preselect`: the display the sharer picked last time on this layout (highlighted, never picked for them). */
    | { kind: 'choose'; choice: OverlayScreenChoice; preselect?: number }
    /** Desktop overlay is not showing and will not on its own: why, as an enum. */
    | { kind: 'off'; reason: string };
let status: OverlayStatus = { kind: 'idle' };
let chosenDisplayId: number | null = null;
const statusListeners = new Set<(s: OverlayStatus) => void>();
function setStatus(next: OverlayStatus): void {
    const same = next.kind === status.kind
        && (next.kind === 'idle' || (next.kind === 'off' && status.kind === 'off' && status.reason === next.reason));
    status = next;
    if (same) return;
    for (const l of statusListeners) { try { l(status); } catch { /* listener's problem */ } }
}
export function getOverlayStatus(): OverlayStatus { return status; }
export function onOverlayStatusChange(cb: (s: OverlayStatus) => void): () => void {
    statusListeners.add(cb);
    return () => { statusListeners.delete(cb); };
}
/** Refusals that will not fix themselves for the rest of the share: worth telling viewers about. */
const STABLE_REFUSALS = new Set(['no_display_match', 'not_whole_screen', 'no_layer_shell', 'helper_failed', 'wayland', 'create_failed', 'addon_missing', 'no_compositor', 'platform']);
/** The sharer's answer to the chooser: a display id, or null to decline (in-app preview only). */
export function answerScreenChoice(displayId: number | null): void {
    if (status.kind !== 'choose') return;
    if (displayId === null) {
        declined = true;
        carry = { sourceId: sourceIdCur, aspect: carry?.aspect ?? null, answer: null, declined: true, savedAt: Date.now() };
        setStatus({ kind: 'off', reason: 'declined' });
        return;
    }
    if (!status.choice.candidates.includes(displayId)) return;
    chosenDisplayId = displayId;
    const picked = status.choice.displays.find(d => d.id === displayId);
    if (picked) {
        const answer = { layout: status.choice.displays.map(d => ({ x: d.x, y: d.y, width: d.width, height: d.height })), chosen: { x: picked.x, y: picked.y, width: picked.width, height: picked.height } };
        let aspect: string | null = null;
        try { aspect = aspectOf(frameGetter?.() ?? undefined); } catch { /* no frame */ }
        carry = { sourceId: sourceIdCur, aspect, answer, declined: false, savedAt: Date.now() };
        // Across shares the answer is trusted only for a portal grant we can bind it to (native path); otherwise it only preselects.
        saveRememberedScreen({ ...answer, grant: factsNow()?.nextGrant ?? null });
    }
    setStatus({ kind: 'idle' });
    retryAt = 0;
    if (refs > 0) schedule();
}
let declined = false;

// One share, many internal restarts (quality change, keep-alive, hardware -> normal fallback, re-publish): the attachment is
// released and re-made each time, and the sharer must not be asked again for a share that has not changed. The answer (and a
// decline) is therefore carried over a restart of the SAME source seen again within RESTART_CARRY_MS, at the same aspect (a
// quality change re-sizes the frame but never re-shapes it). A new share - the sharer picked a source - calls
// forgetScreenAnswer() and starts clean.
export const RESTART_CARRY_MS = 30_000;
interface Carry { sourceId: string; aspect: string | null; answer: { layout: OverlayRect[]; chosen: OverlayRect } | null; declined: boolean; savedAt: number }
let carry: Carry | null = null;
const aspectOf = (f: { width: number; height: number } | undefined): string | null => (f && f.height > 0 ? (f.width / f.height).toFixed(2) : null);
function liveCarry(frame: { width: number; height: number } | undefined): Carry | null {
    if (!carry || carry.sourceId !== sourceIdCur || Date.now() - carry.savedAt > RESTART_CARRY_MS) return null;
    const a = aspectOf(frame);
    return carry.aspect === null || a === null || carry.aspect === a ? carry : null;
}
/** The sharer chose a (possibly different) source: whatever was answered for the previous share no longer applies. */
export function forgetScreenAnswer(): void { carry = null; }
export const _testResetScreenAnswer = (): void => { carry = null; };

const shareKind = (sourceId: string): string => (sourceId.startsWith('window:') ? 'window' : 'screen');

function logOutcome(r: OverlayShowResult): void {
    const k = r.ok ? `ok:${r.how}:${r.captured}` : `no:${r.reason}`;
    if (logged.has(k)) return;
    logged.add(k);
    if (r.ok) {
        logCallEvent('annot_overlay', { result: 'shown', how: r.how, share: shareKind(sourceIdCur), captured: r.captured });
    } else {
        logCallEvent('annot_overlay', {
            result: 'refused', reason: r.reason, share: shareKind(sourceIdCur),
            ...(r.displays !== undefined ? { displays: r.displays } : {}),
            ...(r.addon !== undefined ? { addon: r.addon } : {}),
        });
    }
}

// ── "Is the overlay inside the capture?" (Linux) ─────────────────────────────
// Published by SidebarConference as a participant attribute so viewers stop
// double-drawing (utils/annotationOverlayCapture.ts). Becomes true once main
// has SHOWN the overlay with `captured: true`; stays true for the rest of the
// share (the window coming and going with idle does not change what the share
// may contain from one moment to the next); false again when the share's
// attachment ends.
let capturedNow = false;
const captureListeners = new Set<(captured: boolean) => void>();
function setCaptured(v: boolean): void {
    if (capturedNow === v) return;
    capturedNow = v;
    for (const l of captureListeners) { try { l(v); } catch { /* listener's problem */ } }
}
export function isDesktopOverlayCaptured(): boolean { return capturedNow; }
export function onDesktopOverlayCapturedChange(cb: (captured: boolean) => void): () => void {
    captureListeners.add(cb);
    return () => { captureListeners.delete(cb); };
}

async function showWindow(gen: number): Promise<void> {
    const api = window.electronAPI;
    let res: OverlayShowResult;
    if (!api?.annotationOverlayShow) res = { ok: false, reason: 'platform' };
    else {
        let frame: { width: number; height: number } | undefined;
        try { frame = frameGetter?.() ?? undefined; } catch { frame = undefined; }
        const facts = factsNow();
        const hint = buildShowHint(facts, chosenDisplayId === null ? liveCarry(frame)?.answer ?? null : null, loadRememberedScreen());
        try {
            const raw = hint
                ? await api.annotationOverlayShow(sourceIdCur, frame, chosenDisplayId ?? undefined, hint)
                : chosenDisplayId !== null && frame
                    ? await api.annotationOverlayShow(sourceIdCur, frame, chosenDisplayId)
                    : frame ? await api.annotationOverlayShow(sourceIdCur, frame) : await api.annotationOverlayShow(sourceIdCur);
            res = normalizeShowResult(raw);
        } catch { res = { ok: false, reason: 'create_failed' }; }
    }
    if (gen !== generation || refs === 0) {
        // Released (or re-targeted) while the window was being created.
        if (res.ok) void api?.annotationOverlayHide?.();
        return;
    }
    logOutcome(res);
    if (!res.ok) {
        if (res.reason === 'needs_choice' && res.choice) {
            // Ask once; until answered there is nothing to retry (the question IS the retry).
            chosenDisplayId = null;       // a stale answer (display unplugged) is no answer
            if (!declined) {
                const pre = preselectFromMemory(loadRememberedScreen(), res.choice);
                setStatus({ kind: 'choose', choice: res.choice, ...(pre !== null ? { preselect: pre } : {}) });
            }
            retryAt = Date.now() + REFUSED_RETRY_MS;
            return;
        }
        if (STABLE_REFUSALS.has(res.reason)) setStatus({ kind: 'off', reason: res.reason });
        retryAt = Date.now() + REFUSED_RETRY_MS;
        return;
    }
    if (status.kind !== 'idle') setStatus({ kind: 'idle' });
    retryAt = 0;
    shown = true;
    if (res.how.endsWith('remembered')) {
        // A silently restored grant re-binds the answer to the token the next share will offer (the portal rotates it).
        const next = factsNow()?.nextGrant ?? null;
        const stored = loadRememberedScreen();
        if (stored && next && stored.grant !== next) saveRememberedScreen({ ...stored, grant: next });
    }
    if (carry && carry.sourceId === sourceIdCur) carry.savedAt = Date.now();
    if (res.captured) setCaptured(true);
    sent.clear();
    // Full state first, then live diffs.
    const list = annotationStore.getState().strokes[key] ?? [];
    api?.annotationOverlayPush?.({ reset: true, ...(diffForOverlay(list, sent) ?? {}) });
}

function flush(): void {
    if (!flushPending) return;      // cancelled by stop(), or already run
    flushPending = false;
    if (refs === 0) return;
    const list = annotationStore.getState().strokes[key] ?? [];
    if (list.length > 0) {
        clearIdleTimer();
        if (!shown) {
            // Waiting on the sharer's answer, or they declined: no point asking main again.
            if (status.kind === 'choose' || declined) return;
            const wait = retryAt - Date.now();
            if (wait > 0) {
                // Refused recently: one deferred retry, not one per store change.
                if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, wait);
                return;
            }
            if (!showing) {
                const gen = generation;
                // Re-check afterwards whatever happened — including when this
                // attempt belonged to an attachment that has since been
                // replaced: the new one's flush returned early while this was
                // in flight and would otherwise wait for the next store change.
                showing = showWindow(gen).finally(() => { showing = null; if (refs > 0) schedule(); });
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

/**
 * Queue ONE flush for everything that changed in the current task.
 *
 * This used to be `requestAnimationFrame(flush)`, and that was the owner's
 * "annotations update at like 1 fps while Cipherline is minimized" bug. The
 * whole point of this module is to draw on the desktop while the streamer is
 * looking at something OTHER than Cipherline — so the main window is, by
 * construction, usually minimized or covered (a fullscreen game occludes it,
 * and Chromium's native occlusion tracking then treats it like a minimized
 * window). `backgroundThrottling: false` keeps the page "visible" and its
 * timers unclamped, but it does not make the compositor tick: a minimized /
 * occluded window's compositor is not visible, so BeginFrames — the only
 * thing that runs rAF callbacks — stop or are throttled to about one a
 * second. Every stroke update waited for the next one. Data-channel packets
 * kept arriving at full rate the whole time (they are network tasks); only
 * the hop from the store to the overlay was frame-gated.
 *
 * A MessageChannel post is an ordinary task: it depends on neither frames
 * nor timer clamping (and the overlay window draws on its OWN rAF, which
 * runs because that window is visible). It still coalesces: every store
 * change made before the posted task runs — a burst of packets, a decode
 * that appends many points — rides in one delta. The rate is bounded by the
 * inputs themselves: the transport's per-sender token bucket (60/s) and the
 * pointer-event rate for the streamer's own pen.
 */
function schedule(): void {
    if (flushPending) return;
    flushPending = true;
    const MC = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
    if (typeof MC === 'function') {
        if (!flushChannel) {
            flushChannel = new MC();
            flushChannel.port1.onmessage = flush;
        }
        flushChannel.port2.postMessage(0);
    } else {
        setTimeout(flush, 0);
    }
}

/**
 * Main took the overlay down by itself: on X11 the compositing manager stopped mid-share, so a
 * transparent window would now paint black over the shared screen. Reported the way a refusal at
 * the start is (status "off" with the reason, one `annot_overlay` call event), and the overlay is
 * treated as not shown, so the next stroke asks main again — which shows it once the compositor
 * is back and refuses ('no_compositor') while it is not.
 */
export function onOverlayEndedByMain(): void {
    if (refs === 0) return;
    clearIdleTimer();
    sent.clear();
    shown = false;
    const k = 'ended:no_compositor';
    if (!logged.has(k)) {
        logged.add(k);
        logCallEvent('annot_overlay', { result: 'ended', reason: 'no_compositor', share: shareKind(sourceIdCur) });
    }
    setStatus({ kind: 'off', reason: 'no_compositor' });
    retryAt = Date.now() + REFUSED_RETRY_MS;
    schedule();      // strokes already waiting get their deferred retry
}
let unsubscribeEnded: (() => void) | null = null;

function start(identity: string, sourceId: string): void {
    if (!window.electronAPI?.annotationOverlayShow) return;
    unsubscribeEnded?.();
    unsubscribeEnded = window.electronAPI.onAnnotationOverlayEnded?.(onOverlayEndedByMain) ?? null;
    generation++;
    key = trackKey(identity, Track.Source.ScreenShare);
    sourceIdCur = sourceId;
    sent.clear();
    logged.clear();
    retryAt = 0;
    chosenDisplayId = null;
    declined = !!carry && carry.sourceId === sourceId && carry.declined && Date.now() - carry.savedAt <= RESTART_CARRY_MS;
    setStatus(declined ? { kind: 'off', reason: 'declined' } : { kind: 'idle' });
    unsubscribe = annotationStore.subscribe(schedule);
    // Strokes may already exist (drawn on the in-app tile before this attach).
    schedule();
}

function stop(): void {
    unsubscribeEnded?.();
    unsubscribeEnded = null;
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    flushPending = false;            // a flush already posted becomes a no-op
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryAt = 0;
    hideWindow();
    setCaptured(false);
    if (carry) carry.savedAt = Date.now();      // the restart window counts from the moment the attachment went away
    chosenDisplayId = null;
    declined = false;
    setStatus({ kind: 'idle' });
}

/**
 * Keep the desktop overlay alive for the local screen share of `sourceId`.
 * Returns a release function; the overlay hides when the last holder releases.
 * No-op (returns a no-op release) outside Electron or for a source that is
 * neither a screen nor a window; the main process then decides whether it can
 * actually overlay that source (window shares: Windows and macOS).
 */
export function attachDesktopAnnotationOverlay(
    identity: string,
    sourceId: string,
    /**
     * The size of the shared frame (the capture track's settings), read each time the overlay is
     * shown. On Wayland the portal never says which monitor was picked, so main matches the
     * share to an output by this size (and refuses when it cannot tell); other platforms ignore it.
     */
    getFrame?: () => { width: number; height: number } | null,
    /** What the share's portal said about the stream (native hardware share): its monitor rectangle, and whether the grant was restored silently. */
    getFacts?: () => OverlayShareFacts | null,
): () => void {
    if (!window.electronAPI?.annotationOverlayShow || !isOverlayableSourceId(sourceId)) return () => {};
    refs++;
    if (refs === 1) { frameGetter = getFrame ?? null; factsGetter = getFacts ?? null; start(identity, sourceId); }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refs--;
        if (refs === 0) { stop(); frameGetter = null; factsGetter = null; }
    };
}
