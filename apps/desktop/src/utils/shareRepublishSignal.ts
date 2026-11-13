/**
 * The publisher's half of utils/shareHold.ts: announce a republish before the
 * unpublish, and take the announcement back on every way out of it.
 *
 * The token is opaque and says nothing about what is changing. The server is a
 * blind relay for it like any other attribute.
 */
import { logCallEvent, type CallEventDetail } from './callEventLog';
import { SHARE_REPUBLISH_ATTR } from './shareHold';

/**
 * How long a republish waits for the SFU's echo of the attribute. Normally one
 * round trip (livekit-client polls for it every 50 ms). The attribute is already
 * on the signal socket ahead of the unpublish whether or not the echo arrives, so
 * a slow network costs this at most and never stalls the republish.
 */
export const REPUBLISH_ACK_BOUND_MS = 400;

/**
 * How long the flag stays up after a successful publish. The publish resolving says
 * nothing about viewers: the clear and the new track reach them as separate updates,
 * and a clear that gets there first reads as "not coming back", so the stream closed
 * and came straight back (a real viewer's report: 5 of 8 republishes, `end: cancelled`
 * about 1.6 s in, the new track just behind it). While the flag is up a stop still
 * clears it at once (`cancel`), and a further change replaces it (`begin`).
 */
export const REPUBLISH_CLEAR_DELAY_MS = 3_000;

export interface SignalParticipant {
    setAttributes(attributes: Record<string, string>): Promise<void>;
}

export interface SignalDeps {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    log(detail: CallEventDetail): void;
    /** A token no earlier republish of this client has used. */
    nextToken(): string;
}

export interface RepublishAnnounced { seq: string; acked: boolean }

/** Which attempt a run announced, so its cleanup cannot take back a newer one's flag. */
export interface RepublishRun { seq: string | null }

let counter = 0;

export class ShareRepublishSignal {
    private active: string | null = null;
    private readonly deps: SignalDeps;

    constructor(deps?: Partial<SignalDeps>) {
        this.deps = {
            now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            log: detail => logCallEvent('share_republish', detail),
            nextToken: () => `${Date.now().toString(36)}-${++counter}`,
            ...deps,
        };
    }

    /** Set the flag and wait, bounded, for the SFU to have it. Never throws. */
    async begin(lp: SignalParticipant): Promise<RepublishAnnounced> {
        const seq = this.deps.nextToken();
        this.active = seq;
        const t0 = this.deps.now();
        const acked = await new Promise<boolean>(resolve => {
            this.deps.setTimer(() => resolve(false), REPUBLISH_ACK_BOUND_MS);
            Promise.resolve()
                .then(() => lp.setAttributes({ [SHARE_REPUBLISH_ATTR]: seq }))
                .then(() => resolve(true), () => resolve(false));
        });
        this.deps.log({ phase: 'set', acked, ack_ms: Math.round(this.deps.now() - t0) });
        return { seq, acked };
    }

    /**
     * A republish finished, one way or another. Clears the flag only if it is still
     * this run's: a run that lost the race to a newer change leaves that one's alone.
     * A failure clears now, since that is what tells viewers to stop holding. A success
     * clears after REPUBLISH_CLEAR_DELAY_MS, once the new track has reached them.
     */
    end(lp: SignalParticipant, seq: string | null, why: string): void {
        if (seq === null || this.active !== seq) return;
        if (why !== 'published') { this.clear(lp, why); return; }
        this.deps.setTimer(() => { if (this.active === seq) this.clear(lp, why); }, REPUBLISH_CLEAR_DELAY_MS);
    }

    /**
     * The share is being stopped while a flag is up. Fired, not awaited: it goes down
     * the signal socket ahead of the stop's unpublish, so viewers see "not coming back"
     * first. Does nothing, and costs no traffic, in the normal case with no flag up.
     */
    cancel(lp: SignalParticipant, why = 'stopped'): void {
        if (this.active !== null) this.clear(lp, why);
    }

    private clear(lp: SignalParticipant, why: string): void {
        this.active = null;
        this.deps.log({ phase: 'clear', why });
        Promise.resolve()
            .then(() => lp.setAttributes({ [SHARE_REPUBLISH_ATTR]: '' }))
            .catch(() => { /* the viewer's own timeout covers a clear that never landed */ });
    }
}

export const shareRepublishSignal = new ShareRepublishSignal();

/** A codec swap's announcement (shareRepublish.swapShareCodec): returns what takes it back. */
export async function announceShareSwap(lp: SignalParticipant): Promise<() => void> {
    const { seq } = await shareRepublishSignal.begin(lp);
    return () => shareRepublishSignal.end(lp, seq, 'swap');
}
