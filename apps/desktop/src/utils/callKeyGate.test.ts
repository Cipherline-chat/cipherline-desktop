import { describe, it, expect } from 'vitest';
import {
    resolveCallKeyGate,
    CALL_KEY_STALL_MS,
    CALL_KEY_DEGRADED_GRACE_MS,
    type CallKeyGateInput,
} from './callKeyGate';

const CHAN = 'chan-a';
const OTHER = 'chan-b';

const base: CallKeyGateInput = {
    channelId: CHAN,
    deliveredKeyB64: null,
    status: 'waiting',
    keyB64: null,
    keyChannelId: null,
    lastGoodKeyB64: null,
    lastGoodChannelId: null,
    waitingSinceMs: null,
    nowMs: 1_000_000,
};

describe('resolveCallKeyGate', () => {
    it('REFUSES a DM/group call with no delivered key — the plaintext hole', () => {
        // This suite used to assert `{ kind: 'not_applicable' }` here, i.e.
        // that DM/group calls were not this gate's business. They were nobody
        // else's either: an ungated mount handed CallPane an empty key, which
        // built a LiveKit Room with no `encryption:` block at all, which made
        // E2EEActivator take its keyless branch and run the call in PLAINTEXT
        // to the SFU for its whole duration. A key arriving later could not
        // fix it — a Room built without `encryption:` has no key provider.
        expect(resolveCallKeyGate({ ...base, channelId: null }))
            .toEqual({ kind: 'blocked', stalled: false });
        expect(resolveCallKeyGate({
            ...base, channelId: null, status: 'idle', waitingSinceMs: 0,
        })).toEqual({ kind: 'blocked', stalled: true });
    });

    it('connects a DM/group call once its call_key has been delivered', () => {
        expect(resolveCallKeyGate({ ...base, channelId: null, deliveredKeyB64: 'DM=' }))
            .toEqual({ kind: 'connect', keyB64: 'DM=', degraded: false });
    });

    it('stops implying progress once a DM/group wait passes the stall window', () => {
        const justUnder = {
            ...base, channelId: null,
            waitingSinceMs: base.nowMs - CALL_KEY_STALL_MS + 1,
        };
        expect(resolveCallKeyGate(justUnder)).toEqual({ kind: 'blocked', stalled: false });
        expect(resolveCallKeyGate({ ...justUnder, waitingSinceMs: base.nowMs - CALL_KEY_STALL_MS }))
            .toEqual({ kind: 'blocked', stalled: true });
    });

    it('never re-keys a DM call from a latched Calls-channel key', () => {
        // The trap this branch exists to avoid: the last-known-good latch is
        // matched on channel id, and for a DM call BOTH sides are null — so
        // `lastGoodChannelId === channelId` is null === null, i.e. true. Left
        // to fall through, a DM call with no key of its own would have
        // connected under whatever key some earlier Calls-channel call had
        // latched, and every peer would have heard silence while the UI
        // claimed encryption.
        expect(resolveCallKeyGate({
            ...base,
            channelId: null,
            deliveredKeyB64: null,
            lastGoodKeyB64: 'CHANNEL-KEY=',
            lastGoodChannelId: null,
        })).toEqual({ kind: 'blocked', stalled: false });
    });

    it('ignores a Calls-channel derived key when deciding a DM call', () => {
        // A delivered key is the ONLY thing that connects a DM call.
        expect(resolveCallKeyGate({
            ...base,
            channelId: null,
            deliveredKeyB64: null,
            status: 'ready',
            keyB64: 'AAA=',
            keyChannelId: CHAN,
        })).toEqual({ kind: 'blocked', stalled: false });
    });

    it('ignores a delivered key on a Calls channel, which derives its own', () => {
        expect(resolveCallKeyGate({
            ...base, deliveredKeyB64: 'STRAY=',
        })).toEqual({ kind: 'blocked', stalled: false });
    });

    it('connects on a fresh ready key', () => {
        expect(resolveCallKeyGate({
            ...base, status: 'ready', keyB64: 'AAA=', keyChannelId: CHAN,
        })).toEqual({ kind: 'connect', keyB64: 'AAA=', degraded: false });
    });

    it('blocks when no key has ever been held', () => {
        expect(resolveCallKeyGate({ ...base, waitingSinceMs: base.nowMs }))
            .toEqual({ kind: 'blocked', stalled: false });
    });

    it('marks the wait stalled only past the stall window', () => {
        const justUnder = resolveCallKeyGate({
            ...base, waitingSinceMs: base.nowMs - (CALL_KEY_STALL_MS - 1),
        });
        expect(justUnder).toEqual({ kind: 'blocked', stalled: false });

        const atThreshold = resolveCallKeyGate({
            ...base, waitingSinceMs: base.nowMs - CALL_KEY_STALL_MS,
        });
        expect(atThreshold).toEqual({ kind: 'blocked', stalled: true });
    });

    // ── The security invariants ───────────────────────────────────────────
    it('NEVER returns connect without a non-empty key', () => {
        const emptyish: (string | null)[] = [null, ''];
        for (const keyB64 of emptyish) {
            for (const lastGoodKeyB64 of emptyish) {
                for (const status of ['idle', 'waiting', 'ready'] as const) {
                    const gate = resolveCallKeyGate({
                        ...base,
                        status,
                        keyB64,
                        keyChannelId: CHAN,
                        lastGoodKeyB64,
                        lastGoodChannelId: CHAN,
                        waitingSinceMs: 0,
                    });
                    expect(gate.kind).toBe('blocked');
                }
            }
        }
    });

    it('a ready status with an empty key still blocks — no plaintext fallback', () => {
        expect(resolveCallKeyGate({
            ...base, status: 'ready', keyB64: '', keyChannelId: CHAN, waitingSinceMs: 0,
        })).toEqual({ kind: 'blocked', stalled: true });
    });

    /**
     * The one-render staleness window. `useCallsChannelKey` resets to 'waiting'
     * in an effect, so on the render where the call moves to another Calls
     * channel (moderator force-move, or hopping calls) the hook still reports
     * the PREVIOUS channel's ready key. Connecting on it would join channel B's
     * room under channel A's key.
     */
    it('refuses a ready key derived for a DIFFERENT channel', () => {
        expect(resolveCallKeyGate({
            ...base,
            status: 'ready',
            keyB64: 'CHAN-A-KEY=',
            keyChannelId: OTHER,
            waitingSinceMs: base.nowMs,
        })).toEqual({ kind: 'blocked', stalled: false });
    });

    it('refuses a latched key from a DIFFERENT channel, even mid-call', () => {
        expect(resolveCallKeyGate({
            ...base,
            lastGoodKeyB64: 'CHAN-A-KEY=',
            lastGoodChannelId: OTHER,
            waitingSinceMs: base.nowMs - 60_000,
        })).toEqual({ kind: 'blocked', stalled: true });
    });

    it('falls back to a same-channel latch when the fresh key is another channel’s', () => {
        expect(resolveCallKeyGate({
            ...base,
            status: 'ready',
            keyB64: 'OTHER=',
            keyChannelId: OTHER,
            lastGoodKeyB64: 'MINE=',
            lastGoodChannelId: CHAN,
            waitingSinceMs: base.nowMs - 1000,
        })).toEqual({ kind: 'connect', keyB64: 'MINE=', degraded: false });
    });

    // ── Problem 3: ready → waiting on a LIVE call ─────────────────────────
    it('holds an established call through a transient key gap, silently', () => {
        expect(resolveCallKeyGate({
            ...base,
            status: 'waiting',
            lastGoodKeyB64: 'LIVE=',
            lastGoodChannelId: CHAN,
            waitingSinceMs: base.nowMs - 2000,
        })).toEqual({ kind: 'connect', keyB64: 'LIVE=', degraded: false });
    });

    it('warns (but still holds) once the gap outlives the grace window', () => {
        expect(resolveCallKeyGate({
            ...base,
            status: 'waiting',
            lastGoodKeyB64: 'LIVE=',
            lastGoodChannelId: CHAN,
            waitingSinceMs: base.nowMs - CALL_KEY_DEGRADED_GRACE_MS,
        })).toEqual({ kind: 'connect', keyB64: 'LIVE=', degraded: true });
    });

    it('never escalates a degraded hold into a teardown, however long it lasts', () => {
        // A live call stays connected and encrypted under the key it joined
        // with; hanging it up buys no confidentiality and reads as a crash.
        // The user leaves via the notice's own button instead.
        const gate = resolveCallKeyGate({
            ...base,
            lastGoodKeyB64: 'LIVE=',
            lastGoodChannelId: CHAN,
            waitingSinceMs: base.nowMs - 6 * 60 * 60 * 1000,
        });
        expect(gate).toEqual({ kind: 'connect', keyB64: 'LIVE=', degraded: true });
    });

    it('prefers the fresh key over the latched one when both exist', () => {
        expect(resolveCallKeyGate({
            ...base,
            status: 'ready',
            keyB64: 'NEW=',
            keyChannelId: CHAN,
            lastGoodKeyB64: 'OLD=',
            lastGoodChannelId: CHAN,
            waitingSinceMs: base.nowMs - 60_000,
        })).toEqual({ kind: 'connect', keyB64: 'NEW=', degraded: false });
    });

    it('treats a null waitingSince as zero elapsed rather than NaN', () => {
        expect(resolveCallKeyGate({ ...base, waitingSinceMs: null }))
            .toEqual({ kind: 'blocked', stalled: false });
        expect(resolveCallKeyGate({
            ...base, lastGoodKeyB64: 'LIVE=', lastGoodChannelId: CHAN, waitingSinceMs: null,
        })).toEqual({ kind: 'connect', keyB64: 'LIVE=', degraded: false });
    });

    it('clamps a clock that jumped backwards instead of reporting a stall', () => {
        expect(resolveCallKeyGate({ ...base, waitingSinceMs: base.nowMs + 5000 }))
            .toEqual({ kind: 'blocked', stalled: false });
    });
});

describe('the invariant that keeps media off the relay in the clear', () => {
    const KINDS: CallKeyGateInput[] = [];
    for (const channelId of [null, CHAN, OTHER]) {
        for (const deliveredKeyB64 of [null, '', 'DM=']) {
            for (const status of ['idle', 'waiting', 'ready'] as const) {
                for (const keyB64 of [null, '', 'FRESH=']) {
                    for (const keyChannelId of [null, CHAN, OTHER]) {
                        for (const lastGoodKeyB64 of [null, 'LATCHED=']) {
                            for (const lastGoodChannelId of [null, CHAN, OTHER]) {
                                KINDS.push({
                                    channelId, deliveredKeyB64, status, keyB64, keyChannelId,
                                    lastGoodKeyB64, lastGoodChannelId,
                                    waitingSinceMs: null, nowMs: 1_000_000,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    it("'connect' NEVER carries an empty key, across the whole input space", () => {
        // 1458 combinations. This is the one property the entire feature rests
        // on: every other outcome blocks the mount, so an empty key reaching
        // 'connect' is the same thing as a plaintext call.
        expect(KINDS.length).toBeGreaterThan(1000);
        const bad = KINDS.filter(i => {
            const g = resolveCallKeyGate(i);
            return g.kind === 'connect' && !g.keyB64;
        });
        expect(bad).toEqual([]);
    });

    it('a call with no key available anywhere is ALWAYS blocked', () => {
        const keyless = KINDS.filter(i =>
            !i.deliveredKeyB64 && !i.keyB64 && !i.lastGoodKeyB64);
        expect(keyless.length).toBeGreaterThan(0);
        for (const i of keyless) {
            expect(resolveCallKeyGate(i).kind).toBe('blocked');
        }
    });
});
