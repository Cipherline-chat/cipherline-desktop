/**
 * Who gets your custom sound, and when. Pure and clock-injected.
 *
 *   - Each peer is sent a given sound id ONCE while they are in the call with
 *     you (dedupe). A peer who leaves is forgotten, but is not re-sent within
 *     RESEND_FLOOR_MS of the last send, so someone bouncing in and out of the
 *     call cannot make you upload over and over.
 *   - Sends are coalesced: the caller asks `plan()` after a short debounce;
 *     a burst never starts within MIN_GAP_MS of the previous one (the caller
 *     re-asks at `retryInMs`).
 *   - A hard cap of MAX_BURSTS per call bounds the worst case.
 * Changing your sound mid-call makes every present peer due again (new id).
 */

export const MIN_GAP_MS = 1_000;
export const RESEND_FLOOR_MS = 30_000;
export const MAX_BURSTS = 40;

export type Plan = { to: string[] } | { retryInMs: number } | null;

export class EntranceSendPlanner {
    /** peer -> the last send to them, and whether they have left since. */
    private sent = new Map<string, { id: string; at: number; gone: boolean }>();
    private lastBurstAt = -Infinity;
    private bursts = 0;
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) { this.now = now; }

    /** What to do now for `peers` (the remote identities in the room) and your sound `id`. */
    plan(peers: readonly string[], id: string | null): Plan {
        if (!id || this.bursts >= MAX_BURSTS) return null;
        const t = this.now();
        const due: string[] = [];
        for (const p of peers) {
            const s = this.sent.get(p);
            if (!s || s.id !== id || (s.gone && t - s.at >= RESEND_FLOOR_MS)) due.push(p);
            else if (s.gone) s.gone = false; // back within the floor: they still have it
        }
        if (due.length === 0) return null;
        const wait = this.lastBurstAt + MIN_GAP_MS - t;
        if (wait > 0) return { retryInMs: wait };
        return { to: due };
    }

    markSent(peers: readonly string[], id: string): void {
        const t = this.now();
        for (const p of peers) this.sent.set(p, { id, at: t, gone: false });
        this.lastBurstAt = t;
        this.bursts++;
    }

    /** A peer left the call. */
    left(peer: string): void {
        const s = this.sent.get(peer);
        if (s) s.gone = true;
    }

    burstCount(): number { return this.bursts; }
}
