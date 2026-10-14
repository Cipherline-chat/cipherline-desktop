/**
 * callMove — what the client does when a moderator moves THIS user into
 * another call (`huddle:force_move`).
 *
 * Kept out of Dashboard.tsx so the two promises it makes are testable without
 * mounting a 7k-line component:
 *
 *  - the "you were moved" cue plays exactly once per move, and never for a move
 *    this user made themselves;
 *  - the toast names the call and, when the server said who, the mover.
 *
 * The connection itself (token, LiveKit URL) is NOT handled here — that stays
 * in the Dashboard effect, because it owns the call state setters.
 */

export interface ForceMoveEvent {
    huddle_id: string;
    call_id: string;
    call_name: string;
    moved_by: string;
    /** Server nickname/username of `moved_by`. Absent from older servers. */
    moved_by_name?: string;
    /** Client-side re-fire token (Date.now()); one per received event. */
    nonce: number;
}

/** Fallback when nobody can name the mover. */
export const UNKNOWN_MOVER_LABEL = 'a moderator';

/** True when someone ELSE moved us. A self-initiated move (the server
 *  forbids it, but the client does not rely on that) is silent. */
export function wasMovedByOther(ev: Pick<ForceMoveEvent, 'moved_by'>, selfUserId: string | null | undefined): boolean {
    return !!selfUserId && !!ev.moved_by && ev.moved_by !== selfUserId;
}

/** Best available display name for the mover: what the server sent, else a
 *  local lookup (server nickname / call roster name), else a generic label. */
export function moverLabel(
    ev: Pick<ForceMoveEvent, 'moved_by' | 'moved_by_name'>,
    lookup?: (userId: string) => string | undefined,
): string {
    const fromServer = typeof ev.moved_by_name === 'string' ? ev.moved_by_name.trim() : '';
    if (fromServer) return fromServer;
    const local = lookup?.(ev.moved_by)?.trim();
    return local || UNKNOWN_MOVER_LABEL;
}

export function movedToastMessage(callName: string, mover: string): string {
    return `You were moved to ${callName || 'another call'} by ${mover}.`;
}

export interface AnnounceForceMoveDeps {
    selfUserId: string | null | undefined;
    /** Plays the `call_moved` cue (which itself honours master mute and the
     *  per-cue toggle). */
    playMovedCue: () => void;
    pushToast: (t: { kind: 'info'; title: string; message: string }) => void;
    lookupName?: (userId: string) => string | undefined;
    /** Last nonce announced. A mutable ref-like so a re-run of the effect with
     *  the SAME event (StrictMode, dependency churn) cannot play twice. */
    lastNonce: { current: number | null };
}

/**
 * Announce a move to the user: cue + toast. Returns whether it announced.
 * Idempotent per event nonce.
 */
export function announceForceMove(ev: ForceMoveEvent, deps: AnnounceForceMoveDeps): boolean {
    if (deps.lastNonce.current === ev.nonce) return false;
    deps.lastNonce.current = ev.nonce;
    if (!wasMovedByOther(ev, deps.selfUserId)) return false;

    deps.playMovedCue();
    deps.pushToast({
        kind: 'info',
        title: 'You were moved',
        message: movedToastMessage(ev.call_name, moverLabel(ev, deps.lookupName)),
    });
    return true;
}
