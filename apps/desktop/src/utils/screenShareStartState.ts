/**
 * "Starting screen share…" — the state behind the share button's loading
 * indicator, and the guard that stops a second start while one is running.
 *
 *   idle ──begin──▶ starting ──published──▶ live
 *                      │  ▲
 *        cancelled /   │  └── begin (change source / audio / quality on a live share)
 *        failed        ▼
 *                 idle, or live when the share that was already running
 *                 is still up (a cancelled change-source)
 *
 * `starting` runs from the moment a source is CONFIRMED (picker, quick-share
 * keybind, audio toggle, a republish) until LiveKit has published the track,
 * or the attempt failed. A `begin` while starting is refused — that is the
 * no-double-start rule. Each begin gets an attempt number and only that
 * attempt can settle it, so a slow, superseded attempt can never flip the
 * state of a newer one.
 *
 * Pure (no React, no LiveKit) so the transitions are unit-tested;
 * SidebarConference holds one ShareStartTracker in a ref (synchronous, so a
 * double click inside one frame is still refused) and mirrors `starting` into
 * React state for the button.
 */

export type ShareStartPhase = 'idle' | 'starting' | 'live';
export interface ShareStartState { phase: ShareStartPhase; attempt: number }
export type ShareStartOutcome = 'published' | 'cancelled' | 'failed';
export type ShareStartEvent =
    | { type: 'begin' }
    | { type: 'settle'; attempt: number; outcome: ShareStartOutcome; stillLive: boolean }
    | { type: 'stopped' };

export const SHARE_START_IDLE: ShareStartState = { phase: 'idle', attempt: 0 };

export function shareStartReducer(s: ShareStartState, e: ShareStartEvent): ShareStartState {
    switch (e.type) {
        case 'begin':
            return s.phase === 'starting' ? s : { phase: 'starting', attempt: s.attempt + 1 };
        case 'settle':
            if (s.phase !== 'starting' || e.attempt !== s.attempt) return s;
            if (e.outcome === 'published') return { phase: 'live', attempt: s.attempt };
            return { phase: e.stillLive ? 'live' : 'idle', attempt: s.attempt };
        case 'stopped':
            // A share that ends while another start is running (the old track
            // of a republish) must not cancel the indicator for the new one.
            return s.phase === 'starting' ? s : { phase: 'idle', attempt: s.attempt };
    }
}

export class ShareStartTracker {
    private s: ShareStartState = SHARE_START_IDLE;
    private readonly onChange: (s: ShareStartState) => void;
    constructor(onChange: (s: ShareStartState) => void = () => {}) { this.onChange = onChange; }

    get state(): ShareStartState { return this.s; }
    get starting(): boolean { return this.s.phase === 'starting'; }

    /** Start an attempt. Returns its number, or null when one is already running. */
    begin(): number | null {
        if (this.s.phase === 'starting') return null;
        this.set(shareStartReducer(this.s, { type: 'begin' }));
        return this.s.attempt;
    }

    settle(attempt: number, outcome: ShareStartOutcome, stillLive: boolean): void {
        this.set(shareStartReducer(this.s, { type: 'settle', attempt, outcome, stillLive }));
    }

    stopped(): void {
        this.set(shareStartReducer(this.s, { type: 'stopped' }));
    }

    private set(next: ShareStartState): void {
        if (next === this.s) return;
        this.s = next;
        this.onChange(next);
    }
}

/** What a failed start means for the user. */
export type ShareStartErrorView =
    | { kind: 'cancelled' }
    | { kind: 'failed'; text: string };

/**
 * Turn a capture/publish error into either a silent cancel or the text of
 * the share notice. Linux's xdg-desktop-portal shows its own chooser after
 * ours, and dismissing it rejects getDisplayMedia with NotAllowedError — the
 * user changed their mind, so no error. On macOS the same error means Screen
 * Recording is not granted (or was granted after launch).
 */
export function describeShareStartError(err: unknown, platform: string | undefined): ShareStartErrorView {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError') {
        if (platform === 'linux') return { kind: 'cancelled' };
        if (platform === 'mac') {
            return {
                kind: 'failed',
                text: 'macOS blocked the capture. Turn on Cipherline under Privacy & Security → Screen Recording, then quit and reopen Cipherline.',
            };
        }
        return { kind: 'failed', text: 'Screen share didn’t start: capture was refused. Pick the screen or window again.' };
    }
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'NotFoundError') {
        return { kind: 'failed', text: 'Couldn’t capture that screen or window — it may have closed. Pick it again.' };
    }
    return { kind: 'failed', text: 'Screen share couldn’t start. Try again.' };
}
