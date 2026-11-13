import { describe, it, expect } from 'vitest';
import {
    AccessUnitParser, AU_HEADER_BYTES, NativeInjector, BitrateController, START_FRACTION, mapBitrate, FallbackWatchdog,
    annexBHasIdr, createInjectStage, createLayeredInjectStage, LayerClassifier, nativeShareEncoderEnabled, DEFAULT_INJECTOR_OPTIONS, type NativeAccessUnit,
} from './nativeShareInject';

const IDR = new Uint8Array([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 9, 9]);
const DELTA = new Uint8Array([0, 0, 0, 1, 0x41, 7, 7]);
const au = (key: boolean, data = key ? IDR : DELTA): NativeAccessUnit => ({ key, captureUs: 0, doneUs: 0, data });

function wire(a: { key: boolean; data: Uint8Array }): Uint8Array {
    const out = new Uint8Array(AU_HEADER_BYTES + a.data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, a.data.length, true); out[4] = a.key ? 1 : 0;
    dv.setBigUint64(8, 1000n, true); dv.setBigUint64(16, 2000n, true);
    out.set(a.data, AU_HEADER_BYTES);
    return out;
}

function mk(opts = DEFAULT_INJECTOR_OPTIONS) {
    let t = 1000; const reqs: number[] = [];
    const inj = new NativeInjector(() => reqs.push(t), () => t, opts);
    return { inj, reqs, tick: (ms: number) => { t += ms; } };
}

describe('flag', () => {
    it('is off unless exactly "1"', () => {
        expect(nativeShareEncoderEnabled({})).toBe(false);
        expect(nativeShareEncoderEnabled({ CIPHERLINE_NATIVE_SHARE_ENCODER: '0' })).toBe(false);
        expect(nativeShareEncoderEnabled({ CIPHERLINE_NATIVE_SHARE_ENCODER: 'true' })).toBe(false);
        expect(nativeShareEncoderEnabled({ CIPHERLINE_NATIVE_SHARE_ENCODER: '1' })).toBe(true);
    });
});

describe('AccessUnitParser', () => {
    it('reassembles AUs split at arbitrary chunk boundaries', () => {
        const bytes = new Uint8Array([...wire({ key: true, data: IDR }), ...wire({ key: false, data: DELTA })]);
        const p = new AccessUnitParser(); const got: NativeAccessUnit[] = [];
        for (let i = 0; i < bytes.length; i += 5) got.push(...p.push(bytes.subarray(i, i + 5)));
        expect(got.map(g => g.key)).toEqual([true, false]);
        expect([...got[1].data]).toEqual([...DELTA]);
    });
    it('NEGATIVE: a corrupt length throws instead of allocating', () => {
        const bad = new Uint8Array(AU_HEADER_BYTES); new DataView(bad.buffer).setUint32(0, 0xffffffff, true);
        expect(() => new AccessUnitParser().push(bad)).toThrow(/bad access unit length/);
    });
});

describe('annexBHasIdr', () => {
    it('sees IDR, not delta', () => { expect(annexBHasIdr(IDR)).toBe(true); expect(annexBHasIdr(DELTA)).toBe(false); });
});

describe('key/IDR alignment', () => {
    it('asks for an IDR at start and emits nothing until one arrives', () => {
        const { inj, reqs } = mk();
        expect(reqs.length).toBe(1);
        inj.onAu(au(false));
        expect(inj.next()).toEqual({ kind: 'drop', reason: 'awaiting_idr' });
        expect(inj.stats.deltaDiscarded).toBe(1);
    });
    it('replaces dummy bytes with the AU once synced, IDR then deltas', () => {
        const { inj } = mk();
        inj.onAu(au(true)); inj.onAu(au(false));
        const a = inj.next(), b = inj.next();
        expect(a.kind === 'replace' && a.key).toBe(true);
        expect(b.kind === 'replace' && !b.key).toBe(true);
    });
    it('after a queue-overflow gap, deltas are discarded until the next IDR and an IDR is requested', () => {
        const { inj, reqs, tick } = mk({ ...DEFAULT_INJECTOR_OPTIONS, maxQueue: 2 });
        inj.onAu(au(true)); expect(inj.next().kind).toBe('replace');
        tick(500);
        inj.onAu(au(false)); inj.onAu(au(false)); inj.onAu(au(false));   // overflow -> oldest dropped -> gap
        expect(inj.stats.gaps).toBe(1);
        expect(reqs.length).toBe(2);
        expect(inj.next().kind).toBe('drop'); expect(inj.next().kind).toBe('drop');
        inj.onAu(au(true));
        expect(inj.next().kind).toBe('replace');
    });
    it('NEGATIVE CONTROL: a naive injector (no gap rule) WOULD emit the orphan delta; ours does not', () => {
        const naive: NativeAccessUnit[] = [au(false)];
        expect(naive.shift()).toBeDefined();                          // naive: forwards whatever is next
        const { inj } = mk({ ...DEFAULT_INJECTOR_OPTIONS, maxQueue: 1 });
        inj.onAu(au(true)); inj.next();
        inj.onAu(au(false)); inj.onAu(au(false));                      // gap
        expect(inj.next().kind).toBe('drop');
    });
    it('stale AUs are dropped and count as a gap', () => {
        const { inj, tick } = mk();
        inj.onAu(au(true)); inj.next();
        inj.onAu(au(false)); tick(700);
        expect(inj.next().kind).toBe('drop'); expect(inj.stats.gaps).toBe(1);
    });
    it('a mislabelled AU (flag says delta, bytes are IDR) is trusted by its bytes', () => {
        const { inj } = mk();
        inj.onAu({ ...au(true, IDR), key: false });
        expect(inj.stats.keyMismatch).toBe(1);
        const d = inj.next(); expect(d.kind === 'replace' && d.key).toBe(true);
    });
    it('NEGATIVE: a mislabelled delta (flag IDR, bytes delta) is not treated as a sync point', () => {
        const { inj } = mk();
        inj.onAu({ ...au(false, DELTA), key: true });
        expect(inj.next().kind).toBe('drop');
    });
    it('PLI/needKey requests are rate limited and coalesced into one IDR per interval', () => {
        const { inj, reqs, tick } = mk();
        inj.needKey(); inj.needKey(); expect(reqs.length).toBe(1);          // start-up IDR already pending
        tick(250); inj.needKey(); expect(reqs.length).toBe(1);              // < 1500 ms: held
        tick(1300); inj.next(); expect(reqs.length).toBe(2);                // interval elapsed: the held demand becomes ONE request
        tick(10); inj.needKey(); inj.needKey(); inj.needKey(); expect(reqs.length).toBe(2);
        expect(inj.stats.pliCoalesced).toBeGreaterThan(2);
    });
    it('a gap still gets its IDR quickly (200 ms), independent of the PLI throttle', () => {
        const { inj, reqs, tick } = mk({ ...DEFAULT_INJECTOR_OPTIONS, maxQueue: 1 });
        tick(300); inj.onAu(au(true)); inj.next(); tick(300);
        inj.onAu(au(false)); inj.onAu(au(false));                           // overflow => gap
        expect(reqs.length).toBe(2);
    });
    it('PLI STORM: viewers that keep asking right after each IDR widen the spacing to the 10 s cap (only after a sustained pattern); a quiet period resets it', () => {
        const { inj, reqs, tick } = mk();
        const base = inj.pliInterval();
        tick(13000);                                                        // past the start-up grace
        for (let i = 0; i < 40; i++) {                                      // a broken viewer: PLI every 300 ms for 12 s
            tick(300);
            inj.onAu(au(true)); inj.next();                                  // an IDR goes out whenever one was requested
            inj.needKey();
        }
        expect(inj.pliInterval()).toBe(10000);
        expect(inj.stats.futilePli).toBeGreaterThan(5);
        expect(reqs.length).toBeLessThan(10);                               // vs 40 PLIs: a few IDRs
        tick(7000); inj.needKey();                                          // quiet for > 6 s: back to base
        expect(inj.pliInterval()).toBe(base);
    });
    it('start-up grace: a viewer re-asking right after the first IDRs never triggers the backoff', () => {
        const { inj, tick } = mk();
        for (let i = 0; i < 20; i++) { tick(400); inj.onAu(au(true)); inj.next(); inj.needKey(); }
        expect(inj.stats.futilePli).toBe(0);
        expect(inj.pliInterval()).toBe(1500);
    });
    it('NEGATIVE CONTROL: one or two PLIs right after an IDR (a lost IDR) do NOT widen the spacing', () => {
        const { inj, tick } = mk();
        tick(13000); inj.onAu(au(true)); inj.next(); tick(300); inj.needKey(); tick(300); inj.needKey();
        expect(inj.stats.futilePli).toBe(2);
        expect(inj.pliInterval()).toBe(1500);
    });
    it('NEGATIVE CONTROL: a well-behaved viewer (one PLI per outage, not right after an IDR) does not trigger the backoff', () => {
        const { inj, tick } = mk();
        tick(13000);
        for (let i = 0; i < 5; i++) { tick(5000); inj.needKey(); inj.onAu(au(true)); inj.next(); }
        expect(inj.stats.futilePli).toBe(0);
        expect(inj.pliInterval()).toBe(1500);
    });
    it('reset (encoder failover) forces resync', () => {
        const { inj, tick } = mk();
        inj.onAu(au(true)); inj.next(); tick(300);
        inj.reset(); inj.onAu(au(false));
        expect(inj.next().kind).toBe('drop');
    });
});

describe('intra-refresh routing', () => {
    it('with a refresh callback, PLI demand starts a refresh wave; a GAP still gets a true IDR', () => {
        let t = 1000; const calls: string[] = [];
        const inj = new NativeInjector(() => calls.push('idr'), () => t, { ...DEFAULT_INJECTOR_OPTIONS, maxQueue: 1 }, () => calls.push('refresh'));
        expect(calls).toEqual(['idr']);                                     // start-up: a real IDR
        t += 2000; inj.needKey();
        expect(calls).toEqual(['idr', 'refresh']);                          // PLI -> wave
        t += 300; inj.onAu(au(true)); inj.next(); t += 300; inj.onAu(au(false)); inj.onAu(au(false)); // overflow => gap
        expect(calls[calls.length - 1]).toBe('idr');
    });
    it('NEGATIVE CONTROL: without a refresh callback PLI demand is an IDR (default behaviour unchanged)', () => {
        let t = 1000; const calls: string[] = [];
        const inj = new NativeInjector(() => calls.push('idr'), () => t);
        t += 2000; inj.needKey();
        expect(calls).toEqual(['idr', 'idr']);
    });
});

describe('stage', () => {
    it('replaces frame bytes and drops frames with no AU; a dummy key frame requests an IDR', async () => {
        const { inj, reqs, tick } = mk();
        tick(1600);
        const stage = createInjectStage(inj);
        const w = stage.writable.getWriter(); const r = stage.readable.getReader();
        inj.onAu(au(true));
        const dummy = (type: string) => ({ type, data: new Uint8Array([1, 2, 3]).buffer });
        const pr = r.read();
        await w.write(dummy('key'));
        const first = await pr;
        expect([...new Uint8Array(first.value!.data)]).toEqual([...IDR]);
        expect(reqs.length).toBe(2);                                    // start + dummy key frame (after interval)
        const pr2 = r.read();
        await w.write(dummy('delta'));                                  // no AU left -> dropped, never forwarded as dummy bytes
        await w.close();
        expect((await pr2).done).toBe(true);
    });
});

describe('bitrate mapping', () => {
    it('applies headroom and clamps', () => {
        expect(mapBitrate(20_000_000)).toBe(17_000_000);
        expect(mapBitrate(100_000)).toBe(1_000_000);
        expect(mapBitrate(1e12)).toBe(80_000_000);
    });
    it('NEGATIVE: junk estimates yield no change', () => {
        for (const v of [0, -5, NaN, Infinity]) expect(mapBitrate(v)).toBeNull();
    });
    describe('controller: leads the estimate while the path is clean (report bcde1655: avail flat 3.2 Mbps, loss 0)', () => {
        const clean = { lossPct: 0, rttMs: 60 };
        it('raises the target ABOVE 0.85 x estimate, +25% a step, never over 2x the estimate or the ceiling (once the start floor is gone)', () => {
            let t = 0; const c = new BitrateController(() => t, undefined, 23e6);
            c.update(3.2e6, clean); t += 100; c.update(3.2e6, { lossPct: 3, rttMs: 60 }); t += 6000;   // one congestion event drops the start floor
            const first = c.update(3.2e6, clean);
            expect(first).toBeGreaterThan(0.85 * 3.2e6);
            let prev = first!; let last = prev;
            for (let i = 0; i < 6; i++) { t += 1000; const n = c.update(3.2e6, clean); if (n !== null) { expect(n).toBeGreaterThan(prev); last = prev = n; } }
            expect(last).toBeLessThanOrEqual(2 * 3.2e6);                     // the estimate has not moved: the lead is bounded by it
            t += 1000; expect(new BitrateController(() => t, undefined, 4e6).update(40e6, clean)).toBeLessThanOrEqual(4e6);   // the share's real target is a hard ceiling
        });
        it('NEGATIVE CONTROL: with no ceiling or no signals it is the plain follower (0.85 x estimate, flat)', () => {
            let t = 0;
            const noCeil = new BitrateController(() => t);
            expect(noCeil.update(3.2e6, clean)).toBe(2.72e6);
            t += 1000; expect(noCeil.update(3.2e6, clean)).toBeNull();
            const noSig = new BitrateController(() => t, undefined, 23e6);
            expect(noSig.update(3.2e6)).toBe(2.72e6);
        });
        it('STARTS in the middle: half the ceiling from the first update on a clean path, not the low first estimate (owner 2026-11-13)', () => {
            let t = 0; const c = new BitrateController(() => t, undefined, 20.5e6);
            expect(c.update(1.4e6, clean)).toBe(START_FRACTION * 20.5e6);              // report d9568862 started at ~1.4 Mbps
            t += 1000; expect(c.update(1.4e6, clean)).toBeNull();                       // held at the floor, not pulled back to 2x estimate
            t += 1000; expect(c.update(8e6, clean)).toBe(Math.round(Math.min(20.5e6, 8e6 * 2, 10.25e6 * 1.25)));   // lead catches up -> floor released
            t += 1000; const n = c.update(3e6, clean);                                 // estimate falls back: no floor any more
            expect(n === null || n <= 2 * 3e6).toBe(true);
        });
        it('the start floor is dropped for good at the first congestion', () => {
            let t = 0; const c = new BitrateController(() => t, undefined, 20.5e6);
            expect(c.update(1.4e6, clean)).toBe(10.25e6);
            t += 100; expect(c.update(1.4e6, { lossPct: 5, rttMs: 60 })).toBe(Math.round(0.85 * 1.4e6) < 1e6 ? 1e6 : Math.round(0.85 * 1.4e6));
            t += 6000; const after = c.update(1.4e6, clean);
            expect(after).not.toBeNull(); expect(after!).toBeLessThanOrEqual(2 * 1.4e6);   // back to the normal lead, no floor
        });
        it('NEGATIVE: no ceiling or no path signals -> no start floor (plain follower)', () => {
            const t = 0;
            expect(new BitrateController(() => t).update(1.4e6, clean)).toBe(mapBitrate(1.4e6));
            expect(new BitrateController(() => t, undefined, 20.5e6).update(1.4e6)).toBe(mapBitrate(1.4e6));
        });
        it('loss >= 2% drops straight back to 0.85 x estimate and holds the probe off for 5 s', () => {
            let t = 0; const c = new BitrateController(() => t, undefined, 23e6);
            const high = c.update(3.2e6, clean)!;                            // the start floor (half the ceiling)
            expect(high).toBeGreaterThan(2.72e6);
            t += 100; expect(c.update(3.2e6, { lossPct: 3, rttMs: 60 })).toBe(2.72e6);
            t += 1000; expect(c.update(3.2e6, clean)).toBeNull();            // held: no probing for 5 s
            t += 6000; expect(c.update(3.2e6, clean)).toBeGreaterThan(2.72e6); // then it may probe again
        });
        it('an RTT well above the lowest seen counts as congestion; a missing signal does not', () => {
            let t = 0; const c = new BitrateController(() => t, undefined, 23e6);
            c.update(3.2e6, clean); t += 100; c.update(3.2e6, { lossPct: 3, rttMs: 60 }); t += 6000;   // past the start floor
            c.update(3.2e6, clean); t += 1000; const up = c.update(3.2e6, clean)!;
            t += 1000; expect(c.update(3.2e6, { lossPct: null, rttMs: null })).toBeGreaterThan(up);   // unknown is not congestion
            t += 1000; expect(c.update(3.2e6, { lossPct: 0, rttMs: 60 * 1.5 + 41 })).toBe(2.72e6);
        });
    });
    it('controller: hysteresis and min interval', () => {
        let t = 0; const c = new BitrateController(() => t);
        expect(c.update(20e6)).toBe(17e6);
        t += 2000; expect(c.update(20.5e6)).toBeNull();                 // < 10%
        t += 2000; expect(c.update(10e6)).toBe(8.5e6);
        t += 100; expect(c.update(5e6)).toBeNull();                     // too soon
    });
});

describe('fallback watchdog', () => {
    it('fires once on stall, not while AUs flow', () => {
        let t = 0; const w = new FallbackWatchdog(() => t, 1500);
        t = 1000; w.sawAu(); t = 2400; expect(w.shouldFallBack()).toBe(false);
        t = 3000; expect(w.shouldFallBack()).toBe(true); expect(w.shouldFallBack()).toBe(false);
    });
    it('UNARMED (a portal chooser is open): no stall verdict however long it takes, but a helper exit still ends it', () => {
        let t = 0, dead = false; const w = new FallbackWatchdog(() => t, 1500, () => dead, false);
        t = 60_000; expect(w.shouldFallBack()).toBe(false);
        dead = true; expect(w.shouldFallBack()).toBe(true);
    });
    it('POSITIVE CONTROL: the old always-armed watchdog trips at ~2 s with no AU (the chooser bug); arm() / the first AU start the clock', () => {
        let t = 0; const old = new FallbackWatchdog(() => t, 1500);
        t = 2100; expect(old.shouldFallBack()).toBe(true);
        let t2 = 0; const w = new FallbackWatchdog(() => t2, 1500, () => false, false);
        t2 = 10_000; w.arm(); t2 = 11_000; expect(w.shouldFallBack()).toBe(false); t2 = 11_600; expect(w.shouldFallBack()).toBe(true);
        let t3 = 0; const w3 = new FallbackWatchdog(() => t3, 1500, () => false, false);
        t3 = 10_000; w3.sawAu(); t3 = 11_000; expect(w3.shouldFallBack()).toBe(false); t3 = 11_600; expect(w3.shouldFallBack()).toBe(true);
    });
    it('fires when the helper exits', () => {
        let dead = false; const w = new FallbackWatchdog(() => 0, 1500, () => dead);
        expect(w.shouldFallBack()).toBe(false); dead = true; expect(w.shouldFallBack()).toBe(true);
    });
});

// ── the lighter copy (2-layer simulcast): the low layer's AUs and the layered stage ─────────────────────────────────────

const LOW_IDR = new Uint8Array([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 5, 5, 5]);
const LOW_DELTA = new Uint8Array([0, 0, 0, 1, 0x41, 3, 3, 3]);

describe('AccessUnitParser: the low-layer flag', () => {
    it('reads header flag bit1 as the lighter copy, independent of the key bit', () => {
        const mkWire = (flags: number, data: Uint8Array) => { const w = wire({ key: false, data }); w[4] = flags; return w; };
        const bytes = new Uint8Array([...mkWire(1, IDR), ...mkWire(2, LOW_DELTA), ...mkWire(3, LOW_IDR), ...mkWire(0, DELTA)]);
        const got = new AccessUnitParser().push(bytes);
        expect(got.map(g => [g.key, g.low])).toEqual([[true, false], [false, true], [true, true], [false, false]]);
    });
});

describe('LayerClassifier', () => {
    it('uses the rid: q is the low layer, anything else is full', () => {
        const c = new LayerClassifier();
        expect(c.isLow({ rid: 'q' })).toBe(true);
        expect(c.isLow({ rid: 'h' })).toBe(false);
        expect(c.isLow({ rid: 'f' })).toBe(false);
    });
    it('without a rid, the smaller of two SSRCs is the low layer', () => {
        const c = new LayerClassifier();
        expect(c.isLow({ synchronizationSource: 1, width: 480, height: 270 })).toBe(false);   // only one seen so far: full
        expect(c.isLow({ synchronizationSource: 2, width: 240, height: 135 })).toBe(true);
        expect(c.isLow({ synchronizationSource: 1, width: 480, height: 270 })).toBe(false);
        expect(c.unclassified).toBe(0);
    });
    it('NEGATIVE: a frame with no usable metadata is treated as FULL and counted (never as an unrouted frame)', () => {
        const c = new LayerClassifier();
        expect(c.isLow(undefined)).toBe(false);
        expect(c.isLow({})).toBe(false);
        expect(c.unclassified).toBe(2);
    });
});

describe('createLayeredInjectStage', () => {
    const mkPair = () => {
        let t = 1000; const fullReq: number[] = [], lowReq: number[] = [];
        const full = new NativeInjector(() => fullReq.push(t), () => t), low = new NativeInjector(() => lowReq.push(t), () => t);
        return { full, low, fullReq, lowReq, tick: (ms: number) => { t += ms; } };
    };
    const frame = (rid: string, type = 'delta') => ({ type, data: new Uint8Array([9, 9, 9]).buffer, getMetadata: () => ({ rid }) });
    const bytes = (f: { data: ArrayBuffer }) => [...new Uint8Array(f.data)];

    it('replaces each layer\'s dummy frames with THAT layer\'s access units, never the other\'s', async () => {
        const { full, low } = mkPair();
        full.onAu({ key: true, captureUs: 0, doneUs: 0, data: IDR }); low.onAu({ key: true, captureUs: 0, doneUs: 0, data: LOW_IDR });
        const stage = createLayeredInjectStage(full, low);
        const w = stage.writable.getWriter(); const r = stage.readable.getReader();
        const a = r.read(); await w.write(frame('q', 'key')); const gotLow = await a;
        const b = r.read(); await w.write(frame('h', 'key')); const gotFull = await b;
        expect(bytes(gotLow.value!)).toEqual([...LOW_IDR]);
        expect(bytes(gotFull.value!)).toEqual([...IDR]);
        await w.close();
    });
    it('NEGATIVE: a dummy frame with no access unit for its layer is DROPPED - dummy bytes are never forwarded (either layer)', async () => {
        const { full, low } = mkPair();
        full.onAu({ key: true, captureUs: 0, doneUs: 0, data: IDR });              // only the FULL layer has an AU waiting
        const stage = createLayeredInjectStage(full, low);
        const w = stage.writable.getWriter(); const r = stage.readable.getReader();
        const out: number[][] = [];
        const reader = (async () => { for (;;) { const x = await r.read(); if (x.done) return; out.push(bytes(x.value!)); } })();
        await w.write(frame('q', 'key'));                                           // low frame, low queue empty -> dropped
        await w.write(frame('q'));
        await w.write(frame('h', 'key'));                                           // full frame gets the full AU
        await w.write(frame('h'));                                                  // full queue empty now -> dropped
        await w.close(); await reader;
        expect(out).toEqual([[...IDR]]);
        for (const o of out) expect(o).not.toEqual([9, 9, 9]);
    });
    it('NEGATIVE: the low layer waits for ITS IDR - a low delta AU is not emitted until a low key frame arrived (own alignment)', async () => {
        const { full, low, lowReq } = mkPair();
        low.onAu({ key: false, captureUs: 0, doneUs: 0, data: LOW_DELTA });
        const stage = createLayeredInjectStage(full, low);
        const w = stage.writable.getWriter(); const r = stage.readable.getReader();
        const out: number[][] = [];
        const reader = (async () => { for (;;) { const x = await r.read(); if (x.done) return; out.push(bytes(x.value!)); } })();
        await w.write(frame('q'));
        await w.close(); await reader;
        expect(out).toEqual([]);                                                    // a delta before any IDR is discarded, not forwarded
        expect(lowReq.length).toBeGreaterThanOrEqual(1);                            // ... and it asked ITS encoder for an IDR
    });
    it('a dummy KEY frame on a layer asks only that layer for an IDR', async () => {
        const { full, low, fullReq, lowReq, tick } = mkPair();
        tick(2000);
        const f0 = fullReq.length, l0 = lowReq.length;
        const stage = createLayeredInjectStage(full, low);
        const w = stage.writable.getWriter(); void stage.readable.getReader().read();
        await w.write(frame('q', 'key'));
        expect(lowReq.length).toBe(l0 + 1);
        expect(fullReq.length).toBe(f0);
    });
    it('a throwing getMetadata does not break the stage: the frame is treated as full', async () => {
        const { full, low } = mkPair();
        full.onAu({ key: true, captureUs: 0, doneUs: 0, data: IDR });
        const stage = createLayeredInjectStage(full, low);
        const w = stage.writable.getWriter(); const r = stage.readable.getReader();
        const p = r.read();
        await w.write({ type: 'key', data: new Uint8Array([9]).buffer, getMetadata: () => { throw new Error('gone'); } });
        expect(bytes((await p).value!)).toEqual([...IDR]);
    });
    it('the low layer\'s injector normalises its own stream (E2EE: the same SPS/VUI repair as the full layer)', () => {
        const { low } = mkPair();
        // an AU the normaliser leaves alone is returned byte-identical; the point is that the low injector owns a ReceiverViewNormalizer
        expect(low.viewNormalizer).toBeDefined();
        low.onAu({ key: true, captureUs: 0, doneUs: 0, data: LOW_IDR });
        expect(low.viewNormalizer.stats.passthrough + low.viewNormalizer.stats.spsFixed + low.viewNormalizer.stats.spsUnparsed).toBeGreaterThan(0);
    });
});

describe('AccessUnitParser: the preview flag', () => {
    const rec = (flags: number, payload: Uint8Array) => { const out = new Uint8Array(24 + payload.length); new DataView(out.buffer).setUint32(0, payload.length, true); out[4] = flags; out.set(payload, 24); return out; };
    it('flag bit2 marks a preview record, and an ordinary AU never carries it', () => {
        const got = new AccessUnitParser().push(rec(4, new Uint8Array([1, 0, 1, 0, 9, 9, 9, 255])));
        expect(got[0].preview).toBe(true); expect(got[0].key).toBe(false); expect(got[0].low).toBe(false);
        const au = new AccessUnitParser().push(rec(1, new Uint8Array([0, 0, 0, 1, 0x65])));
        expect(au[0].preview).toBeUndefined();
    });
});
