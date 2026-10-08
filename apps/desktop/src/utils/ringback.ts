/**
 * The outgoing-call ringback (what the CALLER hears while the other side
 * rings). Owner rule (2026-10-08): with instant join the call UI is up on the
 * click, but the ringback must not start until the call is connected and the
 * other side is actually being rung.
 *
 * "Actually being rung" is the start request having created the session — the
 * server notifies the callee's devices inside POST /calls/start — which is
 * exactly what `isInitiator` means here: Dashboard/ChatPane set it only from a
 * successful start that did NOT merge into an existing call. A failed start
 * (403 / 404 / 426 / 429 / network) never produces a call object at all, so
 * it can never get here. "Connected" is our LiveKit room reporting Connected.
 *
 * What the CALLEE hears (the incoming ring, category 'call') is untouched.
 */

/** Ringback stops by itself after this long, as it always has. */
export const RINGBACK_MAX_MS = 15_000;

export interface RingbackInput {
    /** We started this call (start succeeded and created the session). */
    isInitiator: boolean;
    /** Server voice / huddle calls never ring. */
    noRinging: boolean;
    /** Our room reported Connected. */
    roomConnected: boolean;
    /** Everyone in the room, including us. */
    participantCount: number;
    /** Someone else has been in the call at some point (answered). */
    hasConnectedOnce: boolean;
}

export function ringbackWanted(s: RingbackInput): boolean {
    return s.isInitiator && !s.noRinging && s.roomConnected && s.participantCount <= 1 && !s.hasConnectedOnce;
}

/**
 * Starts / stops the loop on transitions of `ringbackWanted`, with the
 * RINGBACK_MAX_MS cap. `play` (passed with each update, so the caller can
 * read its live sound prefs at that moment) starts the loop and returns its
 * stopper (a no-op stopper when the user muted the category). Pulled out of
 * CallPane so every
 * terminal path is unit-testable: answered (count > 1), declined / cancelled /
 * left / failed (CallPane unmounts → dispose), timed out (the cap).
 */
export function createRingbackDriver(
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
) {
    let stop: (() => void) | null = null;
    let cap: unknown = null;
    /** The cap fired: stay quiet until the ringback is no longer wanted. */
    let spent = false;
    const halt = () => {
        if (cap !== null) { timers.clear(cap); cap = null; }
        if (stop) { const s = stop; stop = null; s(); }
    };
    return {
        update(wanted: boolean, play: () => () => void) {
            if (!wanted) { spent = false; halt(); return; }
            if (stop || spent) return;
            stop = play();
            cap = timers.set(() => { spent = true; halt(); }, RINGBACK_MAX_MS);
        },
        dispose: halt,
        get ringing() { return stop !== null; },
    };
}
