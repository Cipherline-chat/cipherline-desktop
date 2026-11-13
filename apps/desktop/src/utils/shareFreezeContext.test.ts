import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    freezeCounters, freezeDelta, freezeRx, freezeFields, quietHealthDue, QUIET_HEALTH_MS, type FreezeCounters,
} from './shareFreezeContext';
import { logShareFreezeStart, logShareFreezeEnd, logShareTxRing } from './shareFreezeLog';
import { ShareRxRing, ShareTxRing, RingLimiter } from './shareSecondRing';
import { getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';
import type { InboundVideoCounters } from './shareLossFallback';

const ctr = (o: Partial<FreezeCounters> = {}): FreezeCounters => ({ packets: 1000, lost: 0, frames: 500, pli: 0, kf: 1, nack: 0, ...o });
const inb = (o: Partial<InboundVideoCounters> = {}): InboundVideoCounters => ({
    packetsReceived: 1000, packetsLost: 0, framesDecoded: 500, pliCount: 0, firCount: 0, nackCount: 0, keyFramesDecoded: 1, frameWidth: 2560, frameHeight: 1440, ...o,
});

describe('freezeCounters', () => {
    it('PLI + FIR are one keyframe-request count; framesReceived comes from the rx snapshot (NaN when absent)', () => {
        const snap = { at: 0, framesReceived: 900, framesDecoded: 800, framesDropped: 0, jbDelay: 0, jbEmitted: 0 };
        expect(freezeCounters(inb({ pliCount: 2, firCount: 1 }), snap)).toMatchObject({ pli: 3, frames: 900, packets: 1000 });
        expect(Number.isNaN(freezeCounters(inb(), null).frames)).toBe(true);
    });
});

describe('freezeDelta and which side stopped', () => {
    it('packets arrive, whole frames arrive, none decodes -> rx "frames": the VIEWER\'s decoder', () => {
        const d = freezeDelta(ctr(), ctr({ packets: 1410, frames: 680, kf: 1 }));
        expect(d).toMatchObject({ packets: 410, frames: 180, pli: 0, kf: 0 });
        expect(freezeRx(d)).toBe('frames');
    });
    it('packets arrive but no frame is assembled -> rx "packets" (loss; the keyframe never came)', () => {
        const d = freezeDelta(ctr(), ctr({ packets: 1300, lost: 100, frames: 500, nack: 12 }));
        expect(d).toMatchObject({ packets: 300, frames: 0, lossPct: 25, nack: 12 });
        expect(freezeRx(d)).toBe('packets');
    });
    it('nothing arrives -> rx "no_packets": upstream (sender, SFU, network)', () => {
        const d = freezeDelta(ctr(), ctr());
        expect(d).toMatchObject({ packets: 0, frames: 0 });
        expect(Number.isNaN(d!.lossPct)).toBe(true); // nothing expected: no percentage
        expect(freezeRx(d)).toBe('no_packets');
    });
    it('"packets arriving but nothing decoding" and "no packets at all" are different words', () => {
        expect(freezeRx(freezeDelta(ctr(), ctr({ packets: 1400, frames: 700 })))).not.toBe(freezeRx(freezeDelta(ctr(), ctr())));
    });
    it('keyframe requests, keyframes decoded and NACKs are counted as deltas', () => {
        const d = freezeDelta(ctr({ pli: 1, kf: 2, nack: 3 }), ctr({ packets: 1100, pli: 4, kf: 3, nack: 10 }))!;
        expect([d.pli, d.kf, d.nack]).toEqual([3, 1, 7]);
    });
    it('a counter that went BACKWARDS (new SSRC / republish) is no delta at all - unknown, never guessed', () => {
        expect(freezeDelta(ctr({ packets: 5000 }), ctr({ packets: 40 }))).toBeNull();
        expect(freezeDelta(ctr({ frames: 5000 }), ctr({ frames: 3 }))).toBeNull();
        expect(freezeDelta(ctr({ kf: 4 }), ctr({ kf: 0 }))).toBeNull();
        expect(freezeRx(null)).toBe('');
    });
    it('packetsLost going down (late arrivals) does not make a negative loss', () => {
        const d = freezeDelta(ctr({ lost: 50 }), ctr({ packets: 1100, lost: 40 }))!;
        expect(d.lossPct).toBe(0);
    });
    it('no baseline (the first sample was the frozen one) -> null', () => {
        expect(freezeDelta(null, ctr())).toBeNull();
        expect(freezeDelta(ctr(), null)).toBeNull();
    });
    it('without framesReceived the verdict falls back to packets, not a wrong "frames"', () => {
        const d = freezeDelta(ctr({ frames: NaN }), ctr({ packets: 1300, frames: NaN }))!;
        expect(Number.isNaN(d.frames)).toBe(true);
        expect(freezeRx(d)).toBe('packets');
    });
});

describe('freezeFields', () => {
    it('9 keys, NaN / "" for what is unknown (the log drops those)', () => {
        const f = freezeFields(null, undefined, undefined);
        expect(Object.keys(f)).toHaveLength(9);
        expect(f.rx).toBe('');
        expect(f.share_ref).toBe('');
        expect(Number.isNaN(f.packets) && Number.isNaN(f.jb_ms)).toBe(true);
    });
    it('carries the share_ref and the jitter buffer when known', () => {
        const f = freezeFields(freezeDelta(ctr(), ctr({ packets: 1100, frames: 600 })), 'a1b2c3d4', 96.4);
        expect(f).toMatchObject({ rx: 'frames', share_ref: 'a1b2c3d4', packets: 100, frames: 100, jb_ms: 96.4 });
    });
});

describe('quiet health line', () => {
    it('a healthy share is due a line once a minute, so silence means "not sampled"', () => {
        expect(quietHealthDue(QUIET_HEALTH_MS - 1, 0)).toBe(false);
        expect(quietHealthDue(QUIET_HEALTH_MS, 0)).toBe(true);
    });
});

// ── the events themselves ──────────────────────────────────────────────────
const EPOCH = 1_791_000_000_000;
beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => 1_000_000);
    vi.spyOn(Date, 'now').mockImplementation(() => EPOCH + 1_000_000);
    clearCallEvents();
});
afterEach(() => vi.restoreAllMocks());

function watchWithRing(rx: ShareRxRing, ref?: string) {
    return { shareRef: ref, ring: rx, ringGate: new RingLimiter(8_000, 16) };
}
function fillFrozen(rx: ShareRxRing) {
    for (let t = 0; t <= 8; t++) {
        const frozen = t > 5;
        rx.observe({
            forEach: cb => cb({ type: 'inbound-rtp', kind: 'video', timestamp: t * 1000, framesReceived: 90 * t, framesDecoded: frozen ? 90 * 5 : 90 * t, framesDropped: 0, packetsReceived: 400 * t, jitterBufferDelay: 0.1 * 90 * Math.min(t, 5), jitterBufferEmittedCount: 90 * Math.min(t, 5) }),
        }, t * 1000, null, null);
    }
}

describe('freeze events of a share', () => {
    it('freeze_start carries the share_ref, the counters and the verdict; track is the share placeholder', () => {
        const rx = new ShareRxRing(); fillFrozen(rx);
        logShareFreezeStart({ track: 'remote-share-1', bg: false, delta: freezeDelta(ctr(), ctr({ packets: 1410, frames: 680 })), watch: watchWithRing(rx, 'a1b2c3d4'), now: 1 });
        const [ev] = getCallEvents();
        expect(ev.kind).toBe('freeze_start');
        expect(ev.detail).toMatchObject({
            track: 'remote-share-1', bg: false, rx: 'frames', share_ref: 'a1b2c3d4', packets: 410, frames: 180, loss_pct: 0, pli: 0, kf: 0, nack: 0,
        });
        expect(ev.detail!.jb_ms).toBeGreaterThan(0);
        expect(validateCallEvent(ev)).toEqual([]);
        expect(Object.keys(ev.detail!).length).toBeLessThanOrEqual(11); // the log keeps the 12th slot for `repeat`
    });

    it('freeze_end carries the whole freeze\'s counters and its length', () => {
        const rx = new ShareRxRing(); fillFrozen(rx);
        logShareFreezeEnd({ track: 'remote-share-1', ms: 21990, delta: freezeDelta(ctr(), ctr({ packets: 1000, frames: 500, pli: 1, kf: 2 })), watch: watchWithRing(rx, 'a1b2c3d4'), now: 1 });
        const ev = getCallEvents().find(e => e.kind === 'freeze_end')!;
        expect(ev.detail).toMatchObject({ track: 'remote-share-1', ms: 21990, rx: 'no_packets', share_ref: 'a1b2c3d4', packets: 0, pli: 1, kf: 1 });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('with no usable delta (counters reset) the line still says which share, and leaves the numbers out', () => {
        logShareFreezeStart({ track: 'remote-share-2', bg: true, delta: null, watch: undefined, now: 1 });
        const ev = getCallEvents()[0];
        expect(ev.detail).toEqual({ track: 'remote-share-2', bg: true });
    });

    it('writes a share_rx_ring next to it: the last seconds, one value each - and obeys the per-share gate', () => {
        const rx = new ShareRxRing(); fillFrozen(rx);
        const watch = watchWithRing(rx, 'a1b2c3d4');
        logShareFreezeStart({ track: 'remote-share-1', bg: false, delta: null, watch, now: 0 });
        logShareFreezeEnd({ track: 'remote-share-1', ms: 3000, delta: null, watch, now: 3_000 }); // 3 s later: held back (gap 8 s)
        const rings = getCallEvents().filter(e => e.kind === 'share_rx_ring');
        expect(rings).toHaveLength(1);
        const d = rings[0].detail!;
        expect(d).toMatchObject({ share_ref: 'a1b2c3d4', track: 'remote-share-1', phase: 'start' });
        expect(d.rx_s).toBe('90/90/90/90/90/90/90/90');
        expect(d.dec_s).toBe('90/90/90/90/90/0/0/0');
        expect(d.pkt_s).toBe('400/400/400/400/400/400/400/400');
        expect(String(d.dec_s).length).toBeLessThanOrEqual(64);
        expect(validateCallEvent(rings[0])).toEqual([]);
    });

    it('the ring event for the END carries the freeze length', () => {
        const rx = new ShareRxRing(); fillFrozen(rx);
        logShareFreezeEnd({ track: 'remote-share-1', ms: 22000, delta: null, watch: watchWithRing(rx, 'a1b2c3d4'), now: 0 });
        expect(getCallEvents().find(e => e.kind === 'share_rx_ring')!.detail).toMatchObject({ phase: 'end', ms: 22000 });
    });

    it('no ring is written when nothing was measured in it', () => {
        logShareFreezeStart({ track: 'remote-share-1', bg: false, delta: null, watch: watchWithRing(new ShareRxRing(), 'a1b2c3d4'), now: 0 });
        expect(getCallEvents().map(e => e.kind)).toEqual(['freeze_start']);
    });

    it('nothing identifying: the logged strings are placeholders, enums, digests and number series', () => {
        const rx = new ShareRxRing(); fillFrozen(rx);
        logShareFreezeStart({ track: 'remote-share-1', bg: false, delta: freezeDelta(ctr(), ctr({ packets: 1100, frames: 600 })), watch: watchWithRing(rx, 'a1b2c3d4'), now: 0 });
        for (const e of getCallEvents()) {
            for (const v of Object.values(e.detail ?? {})) {
                if (typeof v === 'string') expect(v).toMatch(/^(remote-share-\d+|a1b2c3d4|frames|packets|no_packets|start|end|[0-9/-]+)$/);
            }
        }
    });
});

describe('share_tx_ring', () => {
    it('is a valid event with the series and why', () => {
        const tx = new ShareTxRing();
        const rep = (t: number) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => {
            cb({ type: 'outbound-rtp', kind: 'video', rid: 'h', active: true, frameWidth: 2560, frameHeight: 1440, framesEncoded: t < 3 ? 90 * t : 270, framesPerSecond: t <= 3 ? 90 : 0 });
            cb({ type: 'media-source', kind: 'video', framesPerSecond: 90 });
        } });
        for (let t = 0; t <= 6; t++) tx.observe(rep(t), t * 1000);
        const summary = tx.summary()!;
        logShareTxRing({ shareRef: 'a1b2c3d4', why: 'enc', target: 90, summary });
        const ev = getCallEvents()[0];
        expect(ev.kind).toBe('share_tx_ring');
        expect(ev.detail).toMatchObject({ share_ref: 'a1b2c3d4', why: 'enc', target: 90, src_s: '90/90/90/90/90/90', enc_s: '90/90/90/0/0/0', sent_s: '90/90/90/0/0/0', act_s: '1/1/1/1/1/1' });
        expect(validateCallEvent(ev)).toEqual([]);
    });
});
