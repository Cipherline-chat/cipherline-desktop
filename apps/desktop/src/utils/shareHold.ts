/**
 * Holding a viewer's place while a screen share republishes.
 *
 * A fresh republish (a resolution or source change on a hardware encoder:
 * shareLiveRetune.resolutionChangeNeedsFresh / sourceSwapNeedsFresh, and the
 * codec / stall fallbacks) unpublishes the track and publishes a new one 1.4-3.9 s
 * later. To a viewer that looked exactly like the stream ending: focus moved on,
 * fullscreen closed, and the stream came back as a tile somewhere else.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Holding happens ONLY on a positive signal the publisher sends BEFORE the
 * unpublish. An unpublish with no signal is the stream ending, handled on the
 * same tick with no timer: there is no window in which a viewer waits to see
 * whether it comes back, so stopping, leaving and crashing stay instant.
 *
 * ── The signal ─────────────────────────────────────────────────────────────
 * A participant attribute, SHARE_REPUBLISH_ATTR = an opaque per-republish token.
 * It says "republishing, expected back shortly" and nothing else: no source, no
 * resolution. An attribute rather than the metadata blob because `setAttributes`
 * merges while `setMetadata` replaces the whole blob, which three writers share;
 * rather than a data packet because of ordering:
 *   - the publisher's attribute update and its unpublish go down the same signal
 *     socket in that order (it also waits for the SFU's echo, bounded:
 *     shareRepublishSignal.ts), so the SFU applies them in that order;
 *   - viewers receive a ParticipantInfo snapshot holding both, and livekit-client's
 *     RemoteParticipant.updateInfo applies attributes first and reconciles tracks
 *     after, synchronously. So a viewer can only ever see the attribute before, or
 *     in the same update as, the unpublish. No window is needed for that case.
 * A data packet travels a separate channel with no such ordering.
 *
 * The same ordering means CLEARING the attribute can be applied a moment BEFORE
 * the new track in one update, so the clear is judged in a microtask, after
 * updateInfo has finished (attachShareHoldToRoom).
 *
 * ── The states (per publisher identity) ────────────────────────────────────
 *   idle      nothing announced. An unpublish here is a real end.
 *   armed     announced, the old track is still there. Bounded: a flag whose
 *             unpublish never comes expires, and the token is then spent.
 *   holding   the track is gone and expected back. Bounded by HOLD_TIMEOUT_MS;
 *             on expiry the stream closes exactly like a normal end.
 *   resuming  the new publication is here, no frame painted from it yet.
 *
 * A codec swap (shareRepublish.swapShareCodec) publishes the new track first and
 * announces just before taking the old one down: the same flag, but the hold goes
 * straight from armed to resuming when the old track leaves. It needs the hold too:
 * the old track's closing burst of tiny black frames reaches the viewer before its
 * unpublish does, and nothing else would cover them.
 *
 * Each token covers ONE unpublish: once the new track has appeared, the next
 * unpublish is a real stop even if the flag has not been cleared yet. A new
 * token from a further change re-arms, and only then is another hold possible.
 * Every timer carries an id, so a timeout left over from an earlier change can
 * never close the stream that followed it.
 */
import { RoomEvent, Track } from 'livekit-client';
import { logCallEvent, type CallEventDetail } from './callEventLog';

/** LiveKit participant attribute (same `cl.` namespace as hevcNegotiation's `cl.vdec`). */
export const SHARE_REPUBLISH_ATTR = 'cl.share_republish';

/**
 * Longest an announced republish may take to reach its unpublish. All that runs
 * between the two is stopping the native audio capture and a data packet.
 */
export const HOLD_ARM_TIMEOUT_MS = 3_000;

/**
 * Longest a frame stays up with no new publication: what a publisher that crashed
 * mid-republish can cost a viewer. From real republishes: `share_start publish_ms`
 * 1.4-3.9 s in the 1.0.24-staging.178 reports (that includes
 * publishScreenShareSettled's 1.5 s first-frame wait), plus the 50 ms settle and
 * up to 750 ms of codec probing after the unpublish = at most ~4.7 s.
 */
export const HOLD_TIMEOUT_MS = 6_000;

/**
 * Once the new publication exists the publisher is demonstrably alive, so the
 * remaining wait is subscribe + key + first frame. Expiry only drops the
 * placeholder: the stream is there, so nothing closes.
 */
export const HOLD_RESUME_TIMEOUT_MS = 2_500;

/**
 * Ceiling across a run of changes. Each new token restarts the timers (a streamer
 * tapping through resolutions), which must not let a publisher, deliberately or
 * through a loop, keep a frozen frame on someone's screen for as long as it likes.
 */
export const HOLD_TOTAL_CAP_MS = 20_000;

export type ShareHoldPhase = 'idle' | 'armed' | 'holding' | 'resuming';

/** How a hold ended. Only 'timeout' and 'cancelled' are the stream closing late. */
export type ShareHoldEnd =
    | 'resumed'         // the new track painted a frame
    | 'resume_timeout'  // the new publication is there, the frame did not come in time
    | 'timeout'         // no new publication in time: closed as a normal end
    | 'cancelled'       // the publisher cleared the flag with no new track: closed at once
    | 'left'            // the publisher left the room: closed at once
    | 'stopped'         // a real stop right after the republish: closed at once
    | 'disarmed';       // the flag went away, or expired, before any unpublish

export interface ShareHoldState {
    phase: ShareHoldPhase;
    /** The token this phase is following. */
    seq: string | null;
    /** The last token that has been used up; seeing it again means nothing. */
    spent: string | null;
    /** When the run started (first arm); 0 when idle. */
    startedAt: number;
    /** When the track went away; 0 before that. */
    goneAt: number;
    /** Only a timeout event carrying the CURRENT id counts. */
    timerId: number;
}

export type ShareHoldEvent =
    | { type: 'signal'; seq: string; hasPublication: boolean }
    | { type: 'signal_cleared' }
    | { type: 'unpublished' }
    | { type: 'published' }
    | { type: 'first_frame' }
    | { type: 'left' }
    | { type: 'timeout'; timerId: number };

export interface ShareHoldStep {
    state: ShareHoldState;
    /** undefined = leave the running timer; null = cancel it; a number = (re)start it. */
    timerMs?: number | null;
    /** Set when a hold just ended. */
    end?: ShareHoldEnd;
    /** A hold just began: take the last frame now, while the track is still attached. */
    capture?: boolean;
    /** An unpublish with nothing announced: the stream is gone, now. */
    gone?: boolean;
}

export function initialShareHoldState(): ShareHoldState {
    return { phase: 'idle', seq: null, spent: null, startedAt: 0, goneAt: 0, timerId: 0 };
}

const toIdle = (s: ShareHoldState, end: ShareHoldEnd): ShareHoldStep => ({
    state: { ...s, phase: 'idle', spent: s.seq ?? s.spent, seq: null, startedAt: 0, goneAt: 0 },
    timerMs: null,
    end,
});

/** The next timer, never past the ceiling of the whole run. */
const within = (ms: number, startedAt: number, now: number): number =>
    Math.max(0, Math.min(ms, HOLD_TOTAL_CAP_MS - (now - startedAt)));

/** Pure: same state and event, same result. Timers and capture belong to the caller. */
export function stepShareHold(s: ShareHoldState, ev: ShareHoldEvent, now: number): ShareHoldStep {
    if (ev.type === 'timeout' && ev.timerId !== s.timerId) return { state: s };
    const timer = { timerId: s.timerId + 1 };

    switch (s.phase) {
        case 'idle':
            if (ev.type === 'unpublished') return { state: s, gone: true };
            if (ev.type === 'signal' && ev.seq !== s.spent) {
                // Nothing to hold on to: a token with no live publication (a viewer
                // joining mid-republish) changes nothing and is simply used up.
                if (!ev.hasPublication) return { state: { ...s, spent: ev.seq } };
                return {
                    state: { ...s, ...timer, phase: 'armed', seq: ev.seq, startedAt: now, goneAt: 0 },
                    timerMs: HOLD_ARM_TIMEOUT_MS,
                    capture: true,
                };
            }
            return { state: s };

        case 'armed':
            switch (ev.type) {
                case 'unpublished':
                    return {
                        state: { ...s, ...timer, phase: 'holding', goneAt: now },
                        timerMs: within(HOLD_TIMEOUT_MS, s.startedAt, now),
                    };
                case 'signal':
                    if (ev.seq === s.seq) return { state: s };
                    return {
                        state: { ...s, ...timer, seq: ev.seq, spent: s.seq },
                        timerMs: within(HOLD_ARM_TIMEOUT_MS, s.startedAt, now),
                    };
                case 'signal_cleared':
                case 'timeout':
                    return toIdle(s, 'disarmed');
                case 'left':
                    return toIdle(s, 'left');
                default:
                    return { state: s };
            }

        case 'holding':
            switch (ev.type) {
                case 'published':
                    return {
                        state: { ...s, ...timer, phase: 'resuming' },
                        timerMs: within(HOLD_RESUME_TIMEOUT_MS, s.startedAt, now),
                    };
                case 'signal':
                    // A further change during the gap: still coming back, new deadline.
                    if (ev.seq === s.seq) return { state: s };
                    return {
                        state: { ...s, ...timer, seq: ev.seq, spent: s.seq },
                        timerMs: within(HOLD_TIMEOUT_MS, s.startedAt, now),
                    };
                case 'signal_cleared':
                    return toIdle(s, 'cancelled');
                case 'timeout':
                    return toIdle(s, 'timeout');
                case 'left':
                    return toIdle(s, 'left');
                default:
                    return { state: s };
            }

        case 'resuming':
            switch (ev.type) {
                case 'first_frame':
                    return toIdle(s, 'resumed');
                case 'timeout':
                    return toIdle(s, 'resume_timeout');
                case 'unpublished':
                    // This token's one unpublish has already happened. A further one is a stop.
                    return toIdle(s, 'stopped');
                case 'signal':
                    // The streamer tapped again before the new track painted. The frame
                    // already held stays up; the old timer dies with its id.
                    if (ev.seq === s.seq) return { state: s };
                    return {
                        state: { ...s, ...timer, phase: 'armed', seq: ev.seq, spent: s.seq, goneAt: 0 },
                        timerMs: within(HOLD_ARM_TIMEOUT_MS, s.startedAt, now),
                    };
                case 'left':
                    return toIdle(s, 'left');
                default:
                    // Clearing the flag is the normal end of a republish: nothing changes.
                    return { state: s };
            }
    }
}

// ── The tracker: one machine per publisher, with real timers ────────────────

export interface ShareHoldDeps {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    log(detail: CallEventDetail): void;
}

/** Takes the last frame. Returns whether one was captured. */
export type ShareHoldCapture = () => boolean;

const IDLE_IDS: ReadonlySet<string> = new Set<string>();

export class ShareHoldTracker {
    private readonly states = new Map<string, ShareHoldState>();
    private readonly timers = new Map<string, unknown>();
    private readonly captures = new Map<string, Set<ShareHoldCapture>>();
    private readonly listeners = new Set<() => void>();
    private readonly endListeners = new Set<(identity: string, end: ShareHoldEnd) => void>();
    private readonly hadFrame = new Map<string, boolean>();
    private readonly deps: ShareHoldDeps;
    private isSelf: (identity: string) => boolean = () => false;
    private ids: ReadonlySet<string> = IDLE_IDS;

    constructor(deps: ShareHoldDeps) { this.deps = deps; }

    /** For the log only: whether a hold is on our own share. */
    setSelfCheck(fn: (identity: string) => boolean): void { this.isSelf = fn; }

    private state(identity: string): ShareHoldState {
        return this.states.get(identity) ?? initialShareHoldState();
    }

    /** Which phase this publisher is in. Always a primitive: safe as a store snapshot. */
    phase(identity: string): ShareHoldPhase { return this.state(identity).phase; }

    /** A republish is announced or in its gap, so its start and stop are not news. */
    isGapExpected(identity: string): boolean {
        const p = this.phase(identity);
        return p === 'armed' || p === 'holding';
    }

    /** Publishers currently not idle. Stable identity until the membership changes. */
    heldIds(): ReadonlySet<string> { return this.ids; }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    /** Called when a hold ends, for what a normal end would have done at the unpublish (its sound). */
    onEnded(fn: (identity: string, end: ShareHoldEnd) => void): () => void {
        this.endListeners.add(fn);
        return () => { this.endListeners.delete(fn); };
    }

    /**
     * A mounted tile showing this share. Only such a tile can take a frame, which is
     * why someone who is not watching never has one taken: there is no tile to ask.
     */
    registerCapture(identity: string, fn: ShareHoldCapture): () => void {
        let set = this.captures.get(identity);
        if (!set) { set = new Set(); this.captures.set(identity, set); }
        set.add(fn);
        return () => {
            const cur = this.captures.get(identity);
            if (!cur) return;
            cur.delete(fn);
            if (cur.size === 0) this.captures.delete(identity);
        };
    }

    dispatch(identity: string, ev: ShareHoldEvent): void {
        const prev = this.state(identity);
        const now = this.deps.now();
        const step = stepShareHold(prev, ev, now);
        const self = this.isSelf(identity);
        const was = prev.phase;
        const is = step.state.phase;
        if (step.state !== prev) this.states.set(identity, step.state);

        if (step.timerMs !== undefined) {
            const running = this.timers.get(identity);
            if (running !== undefined) { this.deps.clearTimer(running); this.timers.delete(identity); }
            if (step.timerMs !== null) {
                const timerId = step.state.timerId;
                this.timers.set(identity, this.deps.setTimer(
                    () => this.dispatch(identity, { type: 'timeout', timerId }),
                    step.timerMs,
                ));
            }
        }

        // Synchronously, inside the event that armed: the attribute is applied before
        // the track goes in the same update, so the element still has its frame here.
        if (step.capture) {
            let got = false;
            for (const take of this.captures.get(identity) ?? []) {
                try { if (take()) got = true; } catch { /* a failed capture is the fallback */ }
            }
            this.hadFrame.set(identity, got);
            this.deps.log({ phase: 'armed', self, tiles: this.captures.get(identity)?.size ?? 0, frame: got });
        }
        if (step.gone) this.deps.log({ phase: 'gone', self, held: false });
        if (was === 'armed' && is === 'holding') this.deps.log({ phase: 'start', self, frame: !!this.hadFrame.get(identity) });
        if (was === 'holding' && is === 'resuming') this.deps.log({ phase: 'new_track', self, ms: now - prev.goneAt });
        if (is === 'armed' && (was === 'resuming' || was === 'armed' || was === 'holding') && !step.capture) {
            this.deps.log({ phase: 'renewed', self, from: was });
        }
        if (is === 'holding' && was === 'holding' && step.state !== prev) {
            this.deps.log({ phase: 'renewed', self, from: was });
        }

        if (step.end) {
            this.deps.log({
                phase: 'end', self, end: step.end,
                ms: prev.goneAt ? now - prev.goneAt : 0,
                frame: !!this.hadFrame.get(identity),
            });
            this.hadFrame.delete(identity);
        }

        if (was !== is) {
            this.refreshIds(identity, is);
            for (const fn of this.listeners) fn();
        }
        if (step.end) for (const fn of this.endListeners) fn(identity, step.end);
    }

    private refreshIds(identity: string, is: ShareHoldPhase): void {
        const has = this.ids.has(identity);
        if (is !== 'idle' && !has) this.ids = new Set(this.ids).add(identity);
        else if (is === 'idle' && has) {
            const next = new Set(this.ids);
            next.delete(identity);
            this.ids = next;
        }
    }

    /** The publisher left: anything held closes now, and their tokens are forgotten. */
    left(identity: string): void {
        this.dispatch(identity, { type: 'left' });
        this.states.delete(identity);
        this.hadFrame.delete(identity);
    }

    /** The room is gone: drop everything, quietly (no call left to hold anything for). */
    reset(): void {
        for (const t of this.timers.values()) this.deps.clearTimer(t);
        this.timers.clear();
        this.states.clear();
        this.hadFrame.clear();
        const changed = this.ids.size > 0;
        this.ids = IDLE_IDS;
        if (changed) for (const fn of this.listeners) fn();
    }
}

export const shareHold = new ShareHoldTracker({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
    log: detail => logCallEvent('share_hold', detail),
});

// ── Wiring it to a room ─────────────────────────────────────────────────────

interface HoldPublication { source?: unknown; trackSid?: string }
interface HoldParticipant {
    identity: string;
    attributes: Readonly<Record<string, string>>;
    trackPublications?: { values(): Iterable<HoldPublication> };
    getTrackPublication(source: never): unknown;
}
/** The slice of a Room this needs: `on`/`off` by event name, so tests hand it a plain emitter. */
export interface ShareHoldRoom {
    localParticipant?: { identity: string } | null;
    on(event: string, fn: (...args: never[]) => void): unknown;
    off(event: string, fn: (...args: never[]) => void): unknown;
}

const SS = Track.Source.ScreenShare;
const hasShare = (p: HoldParticipant): boolean =>
    !!p.getTrackPublication(SS as never);
/** Another screen-share publication survives this one (the old half of a make-before-break swap). */
const anotherShareRemains = (p: HoldParticipant, pub: HoldPublication): boolean => {
    for (const other of p.trackPublications?.values() ?? []) {
        if (other !== pub && other.trackSid !== pub.trackSid && other.source === SS) return true;
    }
    return false;
};

/**
 * Every screen-share publication this participant has. Normally one; two during a
 * codec swap (shareRepublish.swapShareCodec), where getTrackPublication only ever
 * returns the old one. A viewer has to subscribe to the new one DURING the swap, or
 * it has nothing to show when the old one goes.
 */
export function sharePublications<P extends { source?: unknown }>(
    p: { trackPublications?: { values(): Iterable<P> } },
): P[] {
    return [...(p.trackPublications?.values() ?? [])].filter(pub => pub.source === SS);
}

/**
 * Feed a room's events to the tracker. Call it AFTER registering any listener that
 * asks `isGapExpected` about the same events (CallPane's sound cues): emitters run
 * in registration order, so those then see the state from BEFORE this event, which
 * is what they mean. Returns the detach.
 */
export function attachShareHoldToRoom(room: ShareHoldRoom, tracker: ShareHoldTracker = shareHold): () => void {
    tracker.setSelfCheck(identity => room.localParticipant?.identity === identity);
    let closed = false;

    const onAttributes = (changed: Record<string, string>, p: HoldParticipant) => {
        if (!(SHARE_REPUBLISH_ATTR in changed)) return;
        const seq = p.attributes[SHARE_REPUBLISH_ATTR];
        if (seq) {
            // Synchronously: this must take the frame before the same update removes the track.
            tracker.dispatch(p.identity, { type: 'signal', seq, hasPublication: hasShare(p) });
            return;
        }
        // After updateInfo has finished: the update that clears the flag can be the
        // same one that brings the new track, and it applies attributes first.
        queueMicrotask(() => {
            if (!closed) tracker.dispatch(p.identity, { type: 'signal_cleared' });
        });
    };
    const onUnpublished = (pub: HoldPublication, p: HoldParticipant) => {
        if (pub.source !== SS) return;
        if (anotherShareRemains(p, pub)) {
            // The old half of an announced codec swap: its replacement is already here,
            // so this hold has nothing left to wait for but the new track's first frame.
            if (tracker.phase(p.identity) === 'armed') {
                tracker.dispatch(p.identity, { type: 'unpublished' });
                tracker.dispatch(p.identity, { type: 'published' });
            }
            return;
        }
        tracker.dispatch(p.identity, { type: 'unpublished' });
    };
    const onPublished = (pub: HoldPublication, p: HoldParticipant) => {
        if (pub.source === SS) tracker.dispatch(p.identity, { type: 'published' });
    };
    const onLeft = (p: { identity: string }) => tracker.left(p.identity);
    const onDisconnected = () => tracker.reset();

    const bindings: Array<[string, (...args: never[]) => void]> = [
        [RoomEvent.ParticipantAttributesChanged, onAttributes],
        [RoomEvent.TrackUnpublished, onUnpublished],
        [RoomEvent.LocalTrackUnpublished, onUnpublished],
        [RoomEvent.TrackPublished, onPublished],
        [RoomEvent.LocalTrackPublished, onPublished],
        [RoomEvent.ParticipantDisconnected, onLeft],
        [RoomEvent.Disconnected, onDisconnected],
    ];
    for (const [event, fn] of bindings) room.on(event, fn);
    return () => {
        closed = true;
        for (const [event, fn] of bindings) room.off(event, fn);
        tracker.reset();
        tracker.setSelfCheck(() => false);
    };
}
