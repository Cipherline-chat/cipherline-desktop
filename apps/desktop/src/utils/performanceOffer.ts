/**
 * When the "Your PC is struggling to keep up" offer may appear — for our own
 * camera encode, for decoding other people's video, or both (choosePerfOffer)
 * — and the ONE in-call offer surface it shares with any other in-call offer.
 *
 * Rate limits (same shape as the gaming-mode freeze offer, branch
 * claude/gaming-call-mode utils/gamingVideoOffer.ts, so the two read alike):
 *   - at most ONCE PER CALL, whatever the answer (or none);
 *   - "Not now" (or closing the card) → not again for SNOOZE_MS (a day);
 *   - "Don't ask again" → never again on this device;
 *   - "Lower" sets Camera quality to 720p in Voice & Video (persistent,
 *     visible, reversible there) — which by itself ends the offers, because
 *     the offer is only made while the camera is above 720p.
 *
 * Persisted in secureLocalStore (encrypted at rest), device-global, excluded
 * from backups (backupRegistry.ts): it is about THIS machine. Two fields — no
 * call ids, no participants, nothing about the call. No telemetry, no
 * network.
 *
 * ── One offer at a time ──────────────────────────────────────────────────
 * `acquireCallOfferSlot(id)` / `releaseCallOfferSlot(id)` is the shared
 * surface: an offer may only open while it holds the slot, so two prompts can
 * never stack. Merging the gaming-mode branch: GamingVideoGuard calls
 * `acquireCallOfferSlot('gaming')` where it now calls setOfferRoom(room) (and
 * skips the offer if it returns false — it stays eligible for the next
 * detection), and `releaseCallOfferSlot('gaming')` when the card closes.
 * Both cards render at the same spot (top-left, portalled to body — see
 * CALL_OFFER_WRAPPER_CLASS below; it used to be top-right, which could cover
 * someone in the call); the slot guarantees only one is there.
 */
import secureLocalStore from './secureLocalStore';

export const PERF_OFFER_KEY = 'cipherline_perf_offer';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface PerfOfferState {
    /** Epoch ms before which no offer is shown (after "Not now"). 0 = none. */
    snoozedUntil: number;
    /** "Don't ask again". */
    never: boolean;
}

export const DEFAULT_PERF_OFFER_STATE: Readonly<PerfOfferState> = Object.freeze({ snoozedUntil: 0, never: false });

export function parsePerfOfferState(raw: string | null | undefined): PerfOfferState {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return { ...DEFAULT_PERF_OFFER_STATE };
    try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_PERF_OFFER_STATE };
        const snoozedUntil = typeof v.snoozedUntil === 'number' && Number.isFinite(v.snoozedUntil) && v.snoozedUntil > 0
            ? v.snoozedUntil : 0;
        return { snoozedUntil, never: v.never === true };
    } catch {
        return { ...DEFAULT_PERF_OFFER_STATE };
    }
}

export interface PerfOfferGate {
    state: PerfOfferState;
    now: number;
    shownThisCall: boolean;
    /** The camera's capture height right now (0 = camera off). */
    cameraHeight: number;
    /** Incoming video is on Auto (so "show others lower" would change something). */
    incomingAdjustable?: boolean;
}

/**
 * The rate limits. `cameraHeight` / `incomingAdjustable` say whether
 * "Lower" would change anything: the camera is above 720p, or incoming video
 * is still on Auto. With neither, there is nothing to offer.
 */
export function canOfferPerf({ state, now, shownThisCall, cameraHeight, incomingAdjustable = false }: PerfOfferGate): boolean {
    if (shownThisCall || state.never) return false;
    if (!(cameraHeight > 720) && !incomingAdjustable) return false;
    // A snooze far in the future (clock moved back, corrupted value) is
    // clamped to one SNOOZE_MS rather than honoured forever.
    if (state.snoozedUntil > now && state.snoozedUntil - now <= SNOOZE_MS) return false;
    return true;
}

export type PerfOfferAnswer = 'lower' | 'not-now' | 'never';

export function answerPerfOffer(state: PerfOfferState, answer: PerfOfferAnswer, now: number): PerfOfferState {
    switch (answer) {
        case 'not-now': return { ...state, snoozedUntil: now + SNOOZE_MS };
        case 'never': return { ...state, never: true };
        case 'lower': return { ...state, snoozedUntil: 0 };
    }
}

export function readPerfOfferState(): PerfOfferState {
    try { return parsePerfOfferState(secureLocalStore.getItem(PERF_OFFER_KEY)); } catch { return { ...DEFAULT_PERF_OFFER_STATE }; }
}

export function writePerfOfferState(state: PerfOfferState): void {
    try {
        secureLocalStore.setItem(PERF_OFFER_KEY, JSON.stringify({ snoozedUntil: state.snoozedUntil, never: state.never === true }));
    } catch { /* locked store: the offer may come back, which is harmless */ }
}

export const PERF_OFFER_COPY = {
    title: 'Your PC is struggling to keep up',
    body: 'Lower your camera to 720p to keep things smooth? You can change it back in Settings → Voice & Video.',
    accept: 'Lower to 720p',
    decline: 'Not now',
    never: 'Don’t ask again',
} as const;

// ── Which offer: our encoder, other people's video, or both ───────────────

/**
 * 'camera'   — our own encoder is CPU-limited (callLoadMonitor) and the
 *              camera is above 720p: "Lower your camera to 720p".
 * 'incoming' — decoding other people's video is (receiveLoadMonitor), Auto
 *              incoming quality is on, and ≥ 2 remote cameras are decoding:
 *              "Show other people's cameras in lower quality".
 * 'both'     — both at once: one combined offer.
 * Network trouble on incoming video gets no offer (lowering what we decode
 * would not fix it, and the copy would blame the PC).
 */
export type PerfOfferKind = 'camera' | 'incoming' | 'both';

export interface PerfOfferChoiceInput {
    encodeStrained: boolean;
    decodeStrained: boolean;
    cameraHeight: number;
    incomingMode: 'auto' | 'reduced' | 'datasaver';
    remoteVideoCount: number;
}

export function choosePerfOffer(i: PerfOfferChoiceInput): PerfOfferKind | null {
    const camera = i.encodeStrained && i.cameraHeight > 720;
    const incoming = i.decodeStrained && i.incomingMode === 'auto' && i.remoteVideoCount >= 2;
    if (camera && incoming) return 'both';
    if (camera) return 'camera';
    if (incoming) return 'incoming';
    return null;
}

export interface PerfOfferCopy { title: string; body: string; accept: string; decline: string; never: string }

export function perfOfferCopy(kind: PerfOfferKind): PerfOfferCopy {
    switch (kind) {
        case 'camera': return { ...PERF_OFFER_COPY };
        case 'incoming': return {
            title: 'Lots of video in this call is slowing your PC',
            body: 'Show other people’s cameras in lower quality? You can change it back in Settings → Voice & Video.',
            accept: 'Lower',
            decline: 'Not now',
            never: 'Don’t ask again',
        };
        case 'both': return {
            title: 'Your PC is struggling to keep up',
            body: 'Lower your camera to 720p and show other people’s cameras in lower quality? You can change both back in Settings → Voice & Video.',
            accept: 'Lower both',
            decline: 'Not now',
            never: 'Don’t ask again',
        };
    }
}

/** What "Lower" changes for each offer. */
export function perfOfferEffects(kind: PerfOfferKind): { cameraTier?: '720p'; incomingMode?: 'reduced' } {
    return {
        ...(kind !== 'incoming' ? { cameraTier: '720p' as const } : {}),
        ...(kind !== 'camera' ? { incomingMode: 'reduced' as const } : {}),
    };
}

// ── The shared in-call offer slot ─────────────────────────────────────────

let slotHolder: string | null = null;

/** Where EVERY in-call offer card sits — one definition so the load offer and
 *  the gaming freeze offer can never drift apart.
 *
 *  The TOP-LEFT of the MAIN content pane, not of the window: the window's
 *  top-left is the server rail and the sidebar, and the sidebar is where the
 *  call's own video tiles live (`#call-video-root`), so a window-anchored card
 *  covered the very people it was moved to stay off. (It was top-right before
 *  that, which covered the focused stream's name pill / annotation tools.)
 *  `.app-pane3` is always BELOW the focused-stream row (`#call-focus-root`),
 *  so the card never covers that video's own top-left stats readout either.
 *
 *  The class carries only what is common to every placement; the offsets come
 *  from `callOfferPosition()` (measured at runtime by hooks/useCallOfferAnchor)
 *  or, when the pane cannot be found, from CALL_OFFER_FALLBACK_CLASS.
 *  pointer-events-none: only the card itself takes clicks. z-[9500]: above the
 *  docked call UI, below modals. */
export const CALL_OFFER_WRAPPER_CLASS =
    'fixed z-[9500] w-[340px] max-w-[calc(100vw-2rem)] pointer-events-none';

/** Used when the main pane is not in the DOM (or not measured yet): 56px down,
 *  clear of the 34px titlebar, and 88px in = the 72px rail + a 16px inset. */
export const CALL_OFFER_FALLBACK_CLASS = 'top-14 left-[88px]';

/** Height of the main pane's chat/channel header (ChatPane `h-[54px]`) + a gap:
 *  the card starts below it so it never hides the header's controls. */
export const CALL_OFFER_PANE_HEADER_PX = 54;
export const CALL_OFFER_INSET_PX = 8;
export const CALL_OFFER_SIDE_INSET_PX = 16;
export const CALL_OFFER_WIDTH_PX = 340;
/** Never closer than this to the bottom edge of the viewport. */
const CALL_OFFER_MIN_VISIBLE_PX = 140;

export interface CallOfferPosition { top: number; left: number }

/** Where the card goes, given the main pane's bounding rect. Null rect (pane
 *  not found, or zero-sized because it is hidden) → null: use the fallback
 *  class. Clamped so the card is always fully on screen horizontally and keeps
 *  some of itself visible vertically, on any window size. */
export function callOfferPosition(
    rect: { left: number; top: number; width: number; height: number } | null,
    viewport: { width: number; height: number },
): CallOfferPosition | null {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const maxLeft = Math.max(CALL_OFFER_SIDE_INSET_PX, viewport.width - CALL_OFFER_WIDTH_PX - CALL_OFFER_SIDE_INSET_PX);
    const maxTop = Math.max(0, viewport.height - CALL_OFFER_MIN_VISIBLE_PX);
    return {
        left: Math.round(Math.min(Math.max(rect.left + CALL_OFFER_SIDE_INSET_PX, CALL_OFFER_SIDE_INSET_PX), maxLeft)),
        top: Math.round(Math.min(rect.top + CALL_OFFER_PANE_HEADER_PX + CALL_OFFER_INSET_PX, maxTop)),
    };
}

/** Entry motion for the card: slides in from the LEFT edge it is anchored to
 *  (`.fade-slide-left-enter` in index.css; off under prefers-reduced-motion). */
export const CALL_OFFER_ENTER_CLASS = 'fade-slide-left-enter';

/** Take the single in-call offer surface. False if another offer holds it. */
export function acquireCallOfferSlot(id: string): boolean {
    if (slotHolder !== null && slotHolder !== id) return false;
    slotHolder = id;
    return true;
}

export function releaseCallOfferSlot(id: string): void {
    if (slotHolder === id) slotHolder = null;
}

export function callOfferSlotHolder(): string | null { return slotHolder; }

/** Test-only. */
export function __resetCallOfferSlotForTests(): void { slotHolder = null; }
