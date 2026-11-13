import { describe, it, expect } from 'vitest';
import {
    formatSeries, hasData, ShareRxRing, ShareTxRing, readTxSnapshot, shareFpsDip, RingLimiter, TxRingGate,
    RING_SECONDS, RX_RING_MAX, TX_RING_MAX, TX_RING_GAP_MS, TX_RING_CONTINUING_MS, readPacketsReceived,
} from './shareSecondRing';

const rep = (entries: Record<string, unknown>[]) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => entries.forEach(cb) });

/** A viewer's inbound-rtp at second `t`, with constant per-second rates. */
function inbound(t: number, o: { rx?: number; dec?: number; pkt?: number; drop?: number } = {}) {
    const rx = o.rx ?? 90, dec = o.dec ?? 90, pkt = o.pkt ?? 400;
    return rep([{
        type: 'inbound-rtp', kind: 'video', timestamp: t * 1000, framesReceived: rx * t, framesDecoded: dec * t, framesDropped: (o.drop ?? 0) * t,
        packetsReceived: pkt * t, jitterBufferDelay: 0.1 * dec * t, jitterBufferEmittedCount: dec * t,
    }]);
}
const play = (t: number, shown: number, dropped = 0) => ({ at: t * 1000, total: shown * t + dropped * t, dropped: dropped * t });

describe('formatSeries', () => {
    it('whole numbers, oldest first, "-" for not measured', () => {
        expect(formatSeries([88.4, 89.6, 0, null, 90])).toBe('88/90/0/-/90');
    });
    it('negative / NaN / Infinity are not measurements', () => {
        expect(formatSeries([-1, Number.NaN, Number.POSITIVE_INFINITY, 5])).toBe('-/-/-/5');
    });
    it('clamps a huge value so a 10 s window always fits the call log\'s 64-char string', () => {
        const s = formatSeries(Array.from({ length: RING_SECONDS }, () => 123456));
        expect(s.length).toBeLessThanOrEqual(64);
        expect(s.split('/')).toHaveLength(RING_SECONDS);
    });
    it('drops the OLDEST values when too long (never the newest)', () => {
        const s = formatSeries(Array.from({ length: 30 }, (_, i) => 9000 + i));
        expect(s.length).toBeLessThanOrEqual(64);
        expect(s.endsWith('9029')).toBe(true);
    });
    it('hasData is false for nothing but unknowns', () => {
        expect(hasData([null, null])).toBe(false);
        expect(hasData([null, 0])).toBe(true);
    });
});

describe('ShareRxRing (viewer)', () => {
    it('one row per second: received, decoded, presented fps and packets per second', () => {
        const r = new ShareRxRing();
        const el = {};
        for (let t = 0; t <= 4; t++) r.observe(inbound(t, { rx: 88, dec: 87, pkt: 410 }), t * 1000, play(t, 60), el);
        expect(r.summary()).toEqual({ rx_s: '88/88/88/88', dec_s: '87/87/87/87', disp_s: '60/60/60/60', pkt_s: '410/410/410/410', window_s: 4 });
    });

    it('keeps only the last RING_SECONDS rows', () => {
        const r = new ShareRxRing();
        for (let t = 0; t <= 25; t++) r.observe(inbound(t, { rx: t }), t * 1000, null, null);
        const s = r.summary()!;
        expect(s.window_s).toBe(RING_SECONDS);
        expect(s.rx_s.split('/').at(-1)).toBe('49'); // framesReceived = t*t: the newest second is 25^2 - 24^2
    });

    it('a freeze reads as rx > 0, dec 0 (viewer decoder) - and rx 0 / pkt 0 is upstream', () => {
        const viewerSide = new ShareRxRing();
        const upstream = new ShareRxRing();
        let frD = 0, frU = 0, pD = 0, pU = 0;
        for (let t = 0; t <= 6; t++) {
            const frozen = t > 3;
            if (t > 0) { frD += frozen ? 0 : 90; frU += frozen ? 0 : 90; pD += 410; pU += frozen ? 0 : 410; }
            viewerSide.observe(rep([{ type: 'inbound-rtp', kind: 'video', timestamp: t * 1000, framesReceived: t > 0 ? t * 90 : 0, framesDecoded: frD, framesDropped: 0, packetsReceived: pD, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }]), t * 1000, null, null);
            upstream.observe(rep([{ type: 'inbound-rtp', kind: 'video', timestamp: t * 1000, framesReceived: frU, framesDecoded: frU, framesDropped: 0, packetsReceived: pU, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }]), t * 1000, null, null);
        }
        const v = viewerSide.summary()!;
        expect(v.rx_s).toBe('90/90/90/90/90/90');
        expect(v.dec_s).toBe('90/90/90/0/0/0');
        const u = upstream.summary()!;
        expect(u.rx_s).toBe('90/90/90/0/0/0');
        expect(u.pkt_s.split('/').slice(-3)).toEqual(['0', '0', '0']);
    });

    it('presented 0 while the decoder makes 90 fps is UNKNOWN ("-"), never "0 fps displayed" (report 7d1f7abe)', () => {
        const r = new ShareRxRing();
        const el = {};
        for (let t = 0; t <= 3; t++) r.observe(inbound(t, { rx: 90, dec: 90 }), t * 1000, play(t, 0, 90), el); // all handed frames counted dropped
        expect(r.summary()!.disp_s).toBe('-/-/-');
        expect(r.summary()!.dec_s).toBe('90/90/90');
    });

    it('a real 0 presented with a slow decode stays 0', () => {
        const r = new ShareRxRing();
        const el = {};
        for (let t = 0; t <= 2; t++) r.observe(inbound(t, { rx: 2, dec: 2 }), t * 1000, play(t, 0, 2), el);
        expect(r.summary()!.disp_s).toBe('0/0');
    });

    it('playback counters of a DIFFERENT element are not compared (a tile that moved)', () => {
        const r = new ShareRxRing();
        r.observe(inbound(0), 0, play(0, 60), {});
        r.observe(inbound(1), 1000, play(1, 60), {});
        r.observe(inbound(2), 2000, play(2, 60), {}); // another element now: unknown this second
        expect(r.summary()!.disp_s).toBe('-/-');
    });

    it('a stream that restarted (counters backwards) is a gap, not a negative rate', () => {
        const r = new ShareRxRing();
        const el = {};
        const at = (t: number, frames: number) => rep([{ type: 'inbound-rtp', kind: 'video', timestamp: t * 1000, framesReceived: frames, framesDecoded: frames, framesDropped: 0, packetsReceived: frames * 4, jitterBufferDelay: 0, jitterBufferEmittedCount: frames }]);
        r.observe(at(0, 900), 0, null, el);
        r.observe(at(1, 990), 1000, null, el);
        r.observe(at(2, 30), 2000, null, el);   // a new SSRC: every counter restarted from ~0
        r.observe(at(3, 120), 3000, null, el);
        const s = r.summary()!;
        expect(s.rx_s).toBe('90/-/90');
        expect(s.rx_s).not.toMatch(/-\d/);
    });

    it('a missing report is a gap; nothing measured at all gives no summary', () => {
        const r = new ShareRxRing();
        r.observe(null, 0, null, null);
        r.observe(null, 1000, null, null);
        expect(r.summary()).toBeNull();
    });

    it('two reads inside half a second are one second (the older baseline is kept)', () => {
        const r = new ShareRxRing();
        r.observe(inbound(0), 0, null, null);
        r.observe(inbound(0.2), 200, null, null);
        expect(r.size).toBe(0);
        r.observe(inbound(1), 1000, null, null);
        expect(r.size).toBe(1);
    });

    it('recentJbMs averages the last rows that have one', () => {
        const r = new ShareRxRing();
        for (let t = 0; t <= 4; t++) r.observe(inbound(t), t * 1000, null, null);
        expect(r.recentJbMs()).toBe(100);
        expect(new ShareRxRing().recentJbMs()).toBeUndefined();
    });

    it('reads packetsReceived of the video stream only', () => {
        expect(readPacketsReceived(rep([{ type: 'inbound-rtp', kind: 'audio', packetsReceived: 5 }, { type: 'inbound-rtp', kind: 'video', packetsReceived: 7 }]))).toBe(7);
        expect(readPacketsReceived(rep([]))).toBeNull();
    });
});

describe('ShareTxRing (sharer)', () => {
    const out = (rid: string, w: number, h: number, framesEncoded: number, o: Record<string, unknown> = {}) => ({ type: 'outbound-rtp', kind: 'video', rid, frameWidth: w, frameHeight: h, framesEncoded, framesPerSecond: 90, active: true, ...o });
    const report = (_t: number, layers: Record<string, unknown>[], src?: number) =>
        rep([...layers, ...(src === undefined ? [] : [{ type: 'media-source', kind: 'video', framesPerSecond: src }])]);

    it('captured / encoded / sent fps and active layers per second, on the TOP layer', () => {
        const r = new ShareTxRing();
        for (let t = 0; t <= 3; t++) r.observe(report(t, [out('h', 2560, 1440, 90 * t), out('q', 1280, 720, 30 * t, { framesPerSecond: 30 })], 91), t * 1000);
        expect(r.summary()).toEqual({ src_s: '91/91/91', enc_s: '90/90/90', sent_s: '90/90/90', act_s: '2/2/2', window_s: 3 });
    });

    it('enc_fps 0 with a layer active (an encoder stall) differs from act 0 (dynacast paused every layer)', () => {
        const stalled = new ShareTxRing();
        const paused = new ShareTxRing();
        for (let t = 0; t <= 3; t++) {
            stalled.observe(report(t, [out('h', 2560, 1440, 100, { framesPerSecond: 0 })], 90), t * 1000);
            paused.observe(report(t, [out('h', 2560, 1440, 100, { active: false, framesPerSecond: 0 })], 90), t * 1000);
        }
        expect(stalled.summary()).toMatchObject({ src_s: '90/90/90', enc_s: '0/0/0', sent_s: '0/0/0', act_s: '1/1/1' });
        expect(paused.summary()).toMatchObject({ src_s: '90/90/90', enc_s: '0/0/0', sent_s: '0/0/0', act_s: '0/0/0' });
    });

    it('a static screen (src ~1) and a flat encoder are visible as such', () => {
        const r = new ShareTxRing();
        for (let t = 0; t <= 3; t++) r.observe(report(t, [out('h', 2560, 1440, t, { framesPerSecond: 1 })], 1), t * 1000);
        expect(r.summary()).toMatchObject({ src_s: '1/1/1', enc_s: '1/1/1' });
    });

    it('a change of the top layer or a counter reset gives no encoded rate for that second', () => {
        const r = new ShareTxRing();
        r.observe(report(0, [out('h', 2560, 1440, 900)], 90), 0);
        r.observe(report(1, [out('h', 2560, 1440, 990)], 90), 1000);
        r.observe(report(2, [out('h', 2560, 1440, 20)], 90), 2000);   // republished
        r.observe(report(3, [out('m', 1920, 1080, 500)], 90), 3000);  // another top layer
        expect(r.summary()!.enc_s).toBe('90/-/-');
    });

    it('readTxSnapshot: null without a video outbound; counts only active layers', () => {
        expect(readTxSnapshot(rep([{ type: 'outbound-rtp', kind: 'audio' }]), 1)).toBeNull();
        expect(readTxSnapshot(report(0, [out('h', 2560, 1440, 1), out('q', 1280, 720, 1, { active: false })]), 1)!.act).toBe(1);
    });
});

describe('shareFpsDip', () => {
    it('names the most upstream stage under half the target', () => {
        expect(shareFpsDip({ target: 90, src: 30, enc: 30, sent: 30, act: 1 })).toBe('src');
        expect(shareFpsDip({ target: 90, src: 90, enc: 20, sent: 20, act: 1 })).toBe('enc');
        expect(shareFpsDip({ target: 90, src: 90, enc: 90, sent: 20, act: 1 })).toBe('sent');
    });
    it('exactly half is not a dip; healthy is not a dip', () => {
        expect(shareFpsDip({ target: 90, src: 45, enc: 45, sent: 45, act: 1 })).toBeNull();
        expect(shareFpsDip({ target: 90, src: 89, enc: 90, sent: 88, act: 2 })).toBeNull();
    });
    it('no active layer (dynacast pause): encoded / sent 0 is by design - only the capture can dip', () => {
        expect(shareFpsDip({ target: 90, src: 90, enc: 0, sent: 0, act: 0 })).toBeNull();
        expect(shareFpsDip({ target: 90, src: 5, enc: 0, sent: 0, act: 0 })).toBe('src');
    });
    it('unmeasured values and a zero target are never a dip', () => {
        expect(shareFpsDip({ target: 90, src: Number.NaN, enc: Number.NaN, sent: Number.NaN, act: 1 })).toBeNull();
        expect(shareFpsDip({ target: 0, src: 0, act: 1 })).toBeNull();
    });
});

describe('volume limits', () => {
    it('RingLimiter: a minimum gap and a total cap', () => {
        const l = new RingLimiter(1000, 3);
        expect(l.allow(0)).toBe(true);
        expect(l.allow(500)).toBe(false);
        expect(l.allow(1000)).toBe(true);
        expect(l.allow(2000)).toBe(true);
        expect(l.allow(10_000)).toBe(false); // cap
        expect(l.used).toBe(3);
    });

    it('viewer cap: a share that freezes every 10 s for an hour writes at most RX_RING_MAX summaries', () => {
        const l = new RingLimiter(8_000, RX_RING_MAX);
        let n = 0;
        for (let t = 0; t < 3600; t += 10) if (l.allow(t * 1000)) n++;
        expect(n).toBe(RX_RING_MAX);
    });

    it('TxRingGate: writes when a dip BEGINS, then only rarely while it lasts, and again for a new dip', () => {
        const g = new TxRingGate();
        expect(g.shouldLog(0, null)).toBe(false);
        expect(g.shouldLog(10_000, 'src')).toBe(true);       // begins
        expect(g.shouldLog(20_000, 'src')).toBe(false);      // still the same dip
        expect(g.shouldLog(10_000 + TX_RING_CONTINUING_MS, 'src')).toBe(true); // a long one: again
        expect(g.shouldLog(200_000, null)).toBe(false);      // over
        expect(g.shouldLog(300_000, 'enc')).toBe(true);      // a new dip
    });

    it('TxRingGate: a dip flapping every 10 s is held to the minimum gap and the per-share cap', () => {
        const g = new TxRingGate();
        let n = 0;
        for (let t = 0; t < 7200; t += 10) {
            if (g.shouldLog(t * 1000, t % 20 === 0 ? 'src' : null)) n++;
        }
        expect(n).toBeLessThanOrEqual(TX_RING_MAX);
        expect(TX_RING_GAP_MS).toBeGreaterThan(10_000);
    });

    it('a static screen (src_fps 1 for the whole share) costs ONE summary, not one per sample', () => {
        const g = new TxRingGate();
        let n = 0;
        for (let t = 0; t < 1800; t += 10) if (g.shouldLog(t * 1000, 'src')) n++;
        expect(n).toBeLessThanOrEqual(1 + Math.floor(1800 / (TX_RING_CONTINUING_MS / 1000)));
    });
});
