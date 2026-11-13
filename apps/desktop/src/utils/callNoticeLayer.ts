/**
 * The sharer-side call notice layer: which in-call surface sits above which, and
 * who waits for whom. One definition, so a new notice or prompt cannot quietly
 * land on top of another one's buttons.
 *
 * Two kinds of thing pop up over a call:
 *   - NOTICES: the offer / tip cards in the call's offer slot (encoder overload,
 *     game starvation, camera load, gaming freeze, the long-call card, "drawings
 *     won't show on your screen"). Portalled to <body>, top-left of the main pane
 *     (hooks/useCallOfferAnchor). Useful, never urgent: nothing breaks if one
 *     waits a few seconds.
 *   - PROMPTS: questions the call is blocked on until they are answered — "Which
 *     screen are you sharing?" (call/ScreenChoiceDialog). A modal with a backdrop.
 *
 * The rule: an actionable prompt is never covered by a notice. Before this, the
 * notice cards sat at z 9500 and a ClModal at its default z 1000, so the "can't
 * keep up" card sat ON TOP of the screen chooser and swallowed clicks meant for
 * it until it was dismissed. Now:
 *   1. Order: CALL_NOTICE_Z < CALL_FULLSCREEN_Z < CALL_PROMPT_Z. A prompt sits
 *      above every notice, and above the fullscreen call too (it used to open
 *      underneath it: invisible, yet holding the keyboard focus trap).
 *   2. Queue: while any prompt is open, notices are HELD — taken off screen,
 *      not dismissed — and come back, entry motion and all, once it is answered.
 *      A held card cannot be clicked, cannot steal focus, and is not left
 *      half-visible under the prompt's backdrop where it would read as broken.
 *   3. Notices among themselves never stack: they share one slot
 *      (performanceOffer.acquireCallOfferSlot), and a one-shot notice queues for
 *      it (waitForCallOfferSlot) rather than being dropped.
 *
 * The annotation requests dock (CALL_REQUESTS_DOCK_Z) is actionable too and stays
 * on top of everything; it parks bottom-centre above the call controls, away from
 * the top-left notice column.
 *
 * Pure apart from the tiny hold registry; React bindings live in
 * hooks/useCallNoticeLayer.ts.
 */
import type React from 'react';
import { CALL_OFFER_WRAPPER_CLASS, CALL_OFFER_FALLBACK_CLASS, type CallOfferPosition } from './performanceOffer';

/** Offer / tip cards (the call's offer slot): above the docked call UI. */
export const CALL_NOTICE_Z = 9500;
/** The fullscreen call (call/FullscreenOverlay.tsx `z-[9999]`). Listed so the order can be checked. */
export const CALL_FULLSCREEN_Z = 9999;
/** Blocking, actionable call prompts: above every notice and above the fullscreen call. */
export const CALL_PROMPT_Z = 10050;
/** The annotation requests dock (call/AnnotationRequestsDock.tsx `z-[100000]`). Listed so the order can be checked. */
export const CALL_REQUESTS_DOCK_Z = 100000;

// ── Holds: an open prompt holds the notices back ─────────────────────────────

const holders = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of [...listeners]) { try { l(); } catch { /* listener's problem */ } }
}

/**
 * An actionable prompt is open: hold every notice back until the returned
 * function is called. Several prompts may hold at once (by distinct ids); the
 * notices return when the last one lets go. Releasing twice is harmless.
 */
export function holdCallNotices(id: string): () => void {
    const had = holders.size > 0;
    holders.add(id);
    if (!had) emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (!holders.delete(id)) return;
        if (holders.size === 0) emit();
    };
}

export function callNoticesHeld(): boolean { return holders.size > 0; }

export function subscribeCallNoticeHold(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Test-only. */
export function __resetCallNoticeHoldsForTests(): void { holders.clear(); listeners.clear(); }

// ── Where a notice card's wrapper goes ───────────────────────────────────────

export interface CallOfferWrapper {
    className: string;
    style: React.CSSProperties;
    /** True while a prompt holds the notices back: the card is off screen and must not cue a sound. */
    held: boolean;
}

/**
 * The wrapper every notice card renders in. `pos` is the measured anchor
 * (performanceOffer.callOfferPosition; null = not measured yet, use the fallback
 * offsets). While `held`, `display: none` — not `visibility` (a child could
 * override that) and not unmounting (the card keeps its state, and its entry
 * motion replays when it comes back, because a CSS animation restarts when its
 * element is displayed again).
 */
export function callOfferWrapper(pos: CallOfferPosition | null, held: boolean): CallOfferWrapper {
    const style: React.CSSProperties = { zIndex: CALL_NOTICE_Z };
    if (pos) { style.top = pos.top; style.left = pos.left; }
    if (held) style.display = 'none';
    return {
        className: pos ? CALL_OFFER_WRAPPER_CLASS : `${CALL_OFFER_WRAPPER_CLASS} ${CALL_OFFER_FALLBACK_CLASS}`,
        style,
        held,
    };
}

/** The ClModal `overlayStyle` for an actionable call prompt. */
export const CALL_PROMPT_OVERLAY_STYLE: Readonly<React.CSSProperties> = Object.freeze({ zIndex: CALL_PROMPT_Z });
