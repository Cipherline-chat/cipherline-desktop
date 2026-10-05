/**
 * dragGesture — the click-or-pan decision, as a pure state machine.
 *
 * A press on a zoomed video tile is ambiguous until the pointer moves: it is
 * either a click (toggle focus) or the start of a pan. Getting that wrong in
 * either direction is user-visible — a pan that ends up toggling focus throws
 * away the view the user was navigating, and a click that gets eaten makes the
 * tile feel dead.
 *
 * The rule is a distance threshold measured from the PRESS POINT:
 *
 *   idle ──press──► pending ──moved ≥ DRAG_THRESHOLD_PX from origin──► panning
 *                      │                                                  │
 *                      └── release: it was a click, let it through ───────┤
 *                                                                         │
 *                          release: it was a pan, swallow the click ──────┘
 *
 * Three properties this exists to guarantee, each of which had a bug:
 *
 *  1. The threshold is measured from the ORIGIN, never from the previous
 *     move. A slow drag delivered as many 1px steps must still cross — if
 *     each step is compared against the last one it never does, and the
 *     gesture is misread as a click forever.
 *
 *  2. `panning` LATCHES. Once the gesture is a pan it stays a pan even if the
 *     pointer wanders back inside the threshold before release, so a
 *     there-and-back drag cannot end up toggling focus.
 *
 *  3. Crossing the threshold pans by the delta from the ORIGIN, not from the
 *     crossing point. The content then tracks the cursor exactly, with no
 *     residual DRAG_THRESHOLD_PX of drift between the grab point and the
 *     picture under it.
 *
 * Distance is Euclidean, not Manhattan. Manhattan makes the threshold
 * direction-dependent — a diagonal nudge of (2,2) reads as 4 and would engage
 * a pan the user did not ask for, while the same 2.83px straight up would not.
 */

/**
 * How far the pointer must travel before a press becomes a pan, in CSS px.
 *
 * Three is the conventional slop for this decision (it is what Chromium,
 * GTK and Qt all use for drag-start) and it is comfortably above the
 * one-or-two-pixel wobble a hand puts into a mouse while pressing the button,
 * which is the tremor that would otherwise turn every click into a pan.
 */
export const DRAG_THRESHOLD_PX = 3;

export type DragPhase = 'idle' | 'pending' | 'panning';

export interface DragState {
    phase: DragPhase;
    /** The pointer that opened the gesture; events from any other are ignored. */
    pointerId: number;
    /** Where the button went down. The threshold is always measured from here. */
    originX: number;
    originY: number;
    /** Position the last pan delta was emitted from. */
    lastX: number;
    lastY: number;
}

export interface PanDelta { dx: number; dy: number }

export const IDLE_DRAG: DragState = Object.freeze({
    phase: 'idle', pointerId: -1, originX: 0, originY: 0, lastX: 0, lastY: 0,
});

/** True once the gesture is unambiguously a pan. */
export function isPanning(state: DragState): boolean {
    return state.phase === 'panning';
}

/** True while a gesture is open (press seen, release not yet). */
export function isActive(state: DragState): boolean {
    return state.phase !== 'idle';
}

/** Press. Always starts `pending` — never a pan until the pointer moves. */
export function beginDrag(pointerId: number, x: number, y: number): DragState {
    return { phase: 'pending', pointerId, originX: x, originY: y, lastX: x, lastY: y };
}

/**
 * Move. Returns the next state and the pan delta to apply, or null when the
 * gesture is still ambiguous (or the event belongs to another pointer).
 */
export function moveDrag(
    state: DragState,
    pointerId: number,
    x: number,
    y: number,
): { state: DragState; pan: PanDelta | null } {
    if (state.phase === 'idle' || state.pointerId !== pointerId) return { state, pan: null };

    if (state.phase === 'pending') {
        const dx = x - state.originX;
        const dy = y - state.originY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return { state, pan: null };
        // Crossed. Pan by the whole travel since the press so the picture ends
        // up exactly under the cursor — see property 3 in the header.
        return {
            state: { ...state, phase: 'panning', lastX: x, lastY: y },
            pan: { dx, dy },
        };
    }

    // Already panning: plain incremental delta. No threshold check — the
    // phase latches (property 2).
    return {
        state: { ...state, lastX: x, lastY: y },
        pan: { dx: x - state.lastX, dy: y - state.lastY },
    };
}

/**
 * Release (or cancel). `suppressClick` is true exactly when the gesture was a
 * pan, and is the caller's cue to swallow the click the browser will now
 * synthesise.
 */
export function endDrag(state: DragState, pointerId: number): { state: DragState; suppressClick: boolean } {
    if (state.phase === 'idle' || state.pointerId !== pointerId) return { state, suppressClick: false };
    return { state: IDLE_DRAG, suppressClick: state.phase === 'panning' };
}
