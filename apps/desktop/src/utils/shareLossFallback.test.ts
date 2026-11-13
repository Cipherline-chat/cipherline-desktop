import { describe, it, expect } from 'vitest';
import {
    ShareLossFallback, readInboundVideo, lossPctBetween,
    LOSS_TRIP_PCT, LOSS_SEVERE_PCT, TRIP_TICKS, STUCK_TRIP_TICKS, STUCK_WINDOW_TICKS, CLEAN_LOSS_PCT, CLEAN_TICKS,
    HOLD_MS_INITIAL, HOLD_MS_MAX, PROBE_WINDOW_MS, NO_LOW_TICKS, NO_LOW_RETRY_MS, NO_LOW_RETRY_MS_MAX,
    shareRxFallbackDetail, type ShareRxTick, type InboundVideoCounters,
} from './shareLossFallback';
import { validateCallEvent } from './callEventLog';

const TICK = 2000; // CallEventMonitor samples every 2 s

/** Drives one fallback with a clock that advances one tick per call. */
function driver() {
    const fb = new ShareLossFallback();
    let now = 0;
    const step = (o: Partial<Omit<ShareRxTick, 'now'>> = {}) => {
        now += TICK;
        return fb.observe({ now, lossPct: 0, frozen: false, keyframeAsked: false, wantsTop: true, layers: 2, ...o });
    };
    return { fb, step, at: () => now, wait: (ms: number, o: Partial<Omit<ShareRxTick, 'now'>> = {}) => {
        let last = step(o);
        for (let t = TICK; t < ms; t += TICK) last = step(o);
        return last;
    } };
}

describe('ShareLossFallback — trip (top → lower layer)', () => {
    it(`loss ≥ ${LOSS_TRIP_PCT} % for ${TRIP_TICKS} consecutive ticks trips; one bad tick does not`, () => {
        const d = driver();
        expect(d.step({ lossPct: LOSS_TRIP_PCT })).toEqual({ cap: false, changed: false });
        expect(d.step({ lossPct: LOSS_TRIP_PCT })).toEqual({ cap: true, changed: true, reason: 'loss', holdMs: HOLD_MS_INITIAL });
    });
    it('just under the threshold never trips; a good tick resets the count', () => {
        const d = driver();
        for (let i = 0; i < 20; i++) expect(d.step({ lossPct: LOSS_TRIP_PCT - 0.1 }).cap).toBe(false);
        d.step({ lossPct: 6 });
        d.step({ lossPct: 0 });
        expect(d.step({ lossPct: 6 }).cap).toBe(false);
    });
    it(`a single tick at ≥ ${LOSS_SEVERE_PCT} % trips at once (the 2026-10-23 viewer saw 12–26 %)`, () => {
        expect(driver().step({ lossPct: LOSS_SEVERE_PCT })).toMatchObject({ cap: true, changed: true, reason: 'loss' });
        expect(driver().step({ lossPct: 26.3 })).toMatchObject({ cap: true });
    });
    it('a stuck decoder (no frames + loss or a keyframe request) counts as bad — reason freeze', () => {
        const d = driver();
        d.step({ frozen: true, keyframeAsked: true });
        expect(d.step({ frozen: true, keyframeAsked: true })).toMatchObject({ cap: true, reason: 'freeze' });
        const e = driver();
        e.step({ frozen: true, lossPct: CLEAN_LOSS_PCT });
        expect(e.step({ frozen: true, lossPct: CLEAN_LOSS_PCT })).toMatchObject({ cap: true, reason: 'freeze' });
    });
    it('a still screen (no frames, no loss, no keyframe request) is NOT a freeze', () => {
        const d = driver();
        for (let i = 0; i < 30; i++) expect(d.step({ frozen: true }).cap).toBe(false);
    });
    it('does nothing for a single-layer share or a viewer that does not want the top layer', () => {
        const a = driver();
        for (let i = 0; i < 5; i++) expect(a.step({ lossPct: 30, layers: 1 }).cap).toBe(false);
        const b = driver();
        for (let i = 0; i < 5; i++) expect(b.step({ lossPct: 30, wantsTop: false }).cap).toBe(false);
    });
    it('null loss (no packets this tick) counts as no loss', () => {
        const d = driver();
        for (let i = 0; i < 5; i++) expect(d.step({ lossPct: null }).cap).toBe(false);
    });
});

describe('ShareLossFallback — alternating freezes (windowed trip)', () => {
    // The 2026-11 report: freezes alternated frozen / ok / frozen / ok with PLIs
    // rising and window loss ~1 % (< LOSS_TRIP_PCT), so the consecutive count
    // reset on every thaw and the drop came only on the third freeze.
    const frozen = { frozen: true, keyframeAsked: true, lossPct: 1 } as const;

    it(`${STUCK_TRIP_TICKS} stuck ticks within the last ${STUCK_WINDOW_TICKS} trip, even with ok ticks between: [frozen+pli, ok, frozen+pli, ok]`, () => {
        const d = driver();
        expect(d.step(frozen).cap).toBe(false);
        expect(d.step({ lossPct: 1 }).cap).toBe(false);
        expect(d.step(frozen)).toEqual({ cap: true, changed: true, reason: 'freeze', holdMs: HOLD_MS_INITIAL });
    });
    it('the same pattern with a wider gap still trips while both are inside the window: [frozen, ok, ok, frozen]', () => {
        const d = driver();
        d.step(frozen); d.step(); d.step();
        expect(d.step(frozen)).toMatchObject({ cap: true, reason: 'freeze' });
    });
    it('does not trip on one isolated frozen tick: [frozen, ok, ok, ok, frozen]', () => {
        const d = driver();
        const seq = [frozen, {}, {}, {}, frozen];
        for (const o of seq) expect(d.step(o).cap).toBe(false);
        // ...and the second one has aged out by the time a third would pair with it.
        expect(d.step().cap).toBe(false);
    });
    it('does not trip on clean ticks, or on a still screen that keeps stopping (frozen, no loss, no PLI)', () => {
        const d = driver();
        for (let i = 0; i < 30; i++) expect(d.step().cap).toBe(false);
        const e = driver();
        for (let i = 0; i < 30; i++) expect(e.step({ frozen: i % 2 === 0 }).cap).toBe(false);
    });
    it('lossy-but-not-stuck ticks keep the consecutive rule: [6 %, ok, 6 %] does not trip', () => {
        const d = driver();
        d.step({ lossPct: 6 }); d.step({ lossPct: 0 });
        expect(d.step({ lossPct: 6 }).cap).toBe(false);
    });
    it('a long alternating freeze pattern trips on the second freeze, not the third', () => {
        const d = driver();
        let trippedAt = -1;
        for (let i = 0; i < 12; i++) {
            if (d.step(i % 2 === 0 ? frozen : { lossPct: 1 }).cap) { trippedAt = i; break; }
        }
        expect(trippedAt).toBe(2);
    });
    it('the window starts over after a cap and after recovery (a stale freeze does not pair with a new one)', () => {
        const d = driver();
        d.step(frozen); d.step(frozen);                    // trips
        d.wait(HOLD_MS_INITIAL);                           // clean run -> back up
        expect(d.fb.capped).toBe(false);
        expect(d.step(frozen).cap).toBe(false);            // one freeze after recovery: not enough alone
        expect(d.step().cap).toBe(false);
        expect(d.step(frozen)).toMatchObject({ cap: true });   // a second inside the new window trips
    });
    it('a share that stops wanting the top layer clears the window', () => {
        const d = driver();
        d.step(frozen);
        d.step({ wantsTop: false });
        expect(d.step(frozen).cap).toBe(false);
    });
});

describe('ShareLossFallback — recovery and hysteresis', () => {
    it(`stays down for the hold, then needs ${CLEAN_TICKS} clean ticks before going back up`, () => {
        const d = driver();
        d.step({ lossPct: 20 });
        // During the hold: clean ticks, still capped.
        for (let t = TICK; t < HOLD_MS_INITIAL; t += TICK) expect(d.step()).toEqual({ cap: true, changed: false });
        expect(d.step()).toEqual({ cap: false, changed: true, reason: 'recovered' });
    });
    it('a lossy lower layer keeps it down past the hold; the clean run restarts after any bad tick', () => {
        const d = driver();
        d.step({ lossPct: 20 });
        d.wait(HOLD_MS_INITIAL, { lossPct: 2 });          // past the hold, but not clean
        expect(d.fb.capped).toBe(true);
        d.step(); d.step();
        d.step({ lossPct: CLEAN_LOSS_PCT });               // breaks the clean run
        d.step(); d.step();
        expect(d.fb.capped).toBe(true);
        expect(d.step()).toMatchObject({ cap: false, reason: 'recovered' });
    });
    it(`a re-trip within ${PROBE_WINDOW_MS / 1000} s of going back up doubles the hold, up to ${HOLD_MS_MAX / 1000} s`, () => {
        const d = driver();
        let hold = HOLD_MS_INITIAL;
        expect(d.step({ lossPct: 20 }).holdMs).toBe(hold);
        for (let round = 0; round < 6; round++) {
            d.wait(hold);                                   // hold + clean run → back up
            expect(d.fb.capped).toBe(false);
            const r = d.step({ lossPct: 20 });              // fails again at once
            hold = Math.min(HOLD_MS_MAX, hold * 2);
            expect(r).toMatchObject({ cap: true, holdMs: hold });
        }
        expect(hold).toBe(HOLD_MS_MAX);
    });
    it('a top layer that survives the probe window earns the short hold back', () => {
        const d = driver();
        d.step({ lossPct: 20 });
        d.wait(HOLD_MS_INITIAL);
        d.step({ lossPct: 20 });                            // quick re-trip → 40 s
        d.wait(2 * HOLD_MS_INITIAL);
        expect(d.fb.capped).toBe(false);
        d.wait(PROBE_WINDOW_MS);                            // holds up
        expect(d.step({ lossPct: 20 }).holdMs).toBe(HOLD_MS_INITIAL);
    });
    it('the viewer leaving the top layer (unfocus) while capped lifts the cap', () => {
        const d = driver();
        d.step({ lossPct: 20 });
        expect(d.step({ wantsTop: false })).toEqual({ cap: false, changed: true, reason: 'not_needed' });
    });
});

describe('inbound counters', () => {
    const c = (o: Partial<InboundVideoCounters>): InboundVideoCounters => ({
        packetsReceived: 0, packetsLost: 0, framesDecoded: 0, pliCount: 0, firCount: 0, nackCount: 0,
        keyFramesDecoded: 0, frameWidth: 0, frameHeight: 0, ...o,
    });
    it('reads the inbound-rtp video entry and ignores the rest', () => {
        const rows = [
            { type: 'inbound-rtp', kind: 'audio', packetsLost: 99 },
            { type: 'inbound-rtp', kind: 'video', packetsReceived: 1000, packetsLost: 20, framesDecoded: 300, pliCount: 2, keyFramesDecoded: 3, frameWidth: 1280, frameHeight: 720 },
        ];
        expect(readInboundVideo({ forEach: cb => rows.forEach(r => cb(r)) })).toMatchObject({ packetsReceived: 1000, packetsLost: 20, pliCount: 2, firCount: 0, frameWidth: 1280 });
        expect(readInboundVideo({ forEach: () => {} })).toBeNull();
        expect(readInboundVideo(undefined)).toBeNull();
    });
    it('loss % over an interval; null when nothing arrived; negative lost deltas (late packets) clamp to 0', () => {
        expect(lossPctBetween(c({ packetsReceived: 1000, packetsLost: 10 }), c({ packetsReceived: 1750, packetsLost: 260 }))).toBe(25);
        expect(lossPctBetween(c({ packetsReceived: 10 }), c({ packetsReceived: 10 }))).toBeNull();
        expect(lossPctBetween(c({ packetsReceived: 10, packetsLost: 5 }), c({ packetsReceived: 110, packetsLost: 3 }))).toBe(0);
    });
});

// Measured against LiveKit v1.9.12 (harness/share-e2e): a viewer capped to a
// lower layer the publisher is NOT encoding (its lighter-copy gate said no)
// receives nothing at all — the SFU does not fall back to the full layer.
describe('ShareLossFallback — the lower layer must actually arrive', () => {
    it(`capped + ${NO_LOW_TICKS} ticks without a single packet → cap lifted at once (no_low_layer), long before the hold`, () => {
        const d = driver();
        expect(d.step({ lossPct: 30, packets: 900 })).toMatchObject({ cap: true, changed: true });
        expect(d.step({ lossPct: null, packets: 0, frozen: true })).toEqual({ cap: true, changed: false });
        expect(d.step({ lossPct: null, packets: 0, frozen: true })).toEqual({ cap: false, changed: true, reason: 'no_low_layer' });
        expect(d.at()).toBeLessThan(HOLD_MS_INITIAL);
    });
    it(`…and is not tried again for ${NO_LOW_RETRY_MS / 1000} s, then again (the retry doubles per miss, up to ${NO_LOW_RETRY_MS_MAX / 1000} s)`, () => {
        const d = driver();
        const missOnce = () => { d.step({ packets: 0 }); return d.step({ packets: 0 }); };
        d.step({ lossPct: 30 });
        expect(missOnce().reason).toBe('no_low_layer');
        const t0 = d.at();
        while (d.at() - t0 < NO_LOW_RETRY_MS - TICK) expect(d.step({ lossPct: 30 }).cap).toBe(false);
        expect(d.step({ lossPct: 30 })).toMatchObject({ cap: true, changed: true });
        expect(missOnce().reason).toBe('no_low_layer');
        const t1 = d.at();
        while (d.at() - t1 < 2 * NO_LOW_RETRY_MS - TICK) expect(d.step({ lossPct: 30 }).cap).toBe(false);
        expect(d.step({ lossPct: 30 }).cap).toBe(true);
        // The doubling stops at the max.
        for (let i = 0; i < 6; i++) {
            missOnce();
            const t = d.at();
            let n = 0;
            while (!d.step({ lossPct: 30 }).cap) n++;
            expect((d.at() - t)).toBeLessThanOrEqual(NO_LOW_RETRY_MS_MAX + TICK);
            expect(n).toBeGreaterThan(0);
        }
    });
    it('a lower layer that arrives keeps the cap through the hold, as before', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        for (let t = TICK; t < HOLD_MS_INITIAL; t += TICK) expect(d.step({ packets: 300 })).toEqual({ cap: true, changed: false });
        expect(d.step({ packets: 300 })).toMatchObject({ cap: false, reason: 'recovered' });
    });
    it('silence AFTER the lower layer delivered (still screen, copy stopped) lifts the cap without blocking the next fallback', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        d.step({ packets: 300 });
        d.step({ packets: 0 });
        expect(d.step({ packets: 0 })).toMatchObject({ cap: false, reason: 'no_low_layer' });
        expect(d.step({ lossPct: 30 })).toMatchObject({ cap: true, changed: true });
    });
    // Measured: after a cap the SFU kept forwarding the FULL layer for ~4 s
    // (lossy packets, 1080p frames), then went silent — those packets must not
    // count as the lower layer having arrived.
    it('full-layer packets draining after the cap do not count as the lower layer; a smaller decoded frame does', () => {
        const d = driver();
        d.step({ frameShort: 1080, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1080, packets: 900 });            // cap
        d.step({ lossPct: 80, frameShort: 1080, packets: 400 });            // still the full layer
        d.step({ packets: 0, frameShort: 1080 });
        expect(d.step({ packets: 0, frameShort: 1080 })).toMatchObject({ cap: false, reason: 'no_low_layer' });
        expect(d.step({ lossPct: 30, frameShort: 1080 }).cap).toBe(false); // blocked: never delivered
        const e = driver();
        e.step({ frameShort: 1080, packets: 900 });
        e.step({ lossPct: 30, frameShort: 1080, packets: 900 });
        e.step({ frameShort: 720, packets: 300 });                          // the lower layer
        e.step({ packets: 0, frameShort: 720 });
        expect(e.step({ packets: 0, frameShort: 720 })).toMatchObject({ cap: false, reason: 'no_low_layer' });
        expect(e.step({ lossPct: 30, frameShort: 1080 }).cap).toBe(true);  // not blocked
    });
    it('unknown packet counts never lift the cap', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        for (let t = TICK; t < HOLD_MS_INITIAL; t += TICK) expect(d.step({ lossPct: null, frozen: true }).cap).toBe(true);
    });
});

describe('share_rx_fallback event detail', () => {
    it('meets the call-event contract (a *fallback kind carries from/to)', () => {
        for (const d of [{ cap: true, changed: true, reason: 'loss' as const, holdMs: 20_000 }, { cap: false, changed: true, reason: 'no_low_layer' as const }]) {
            const detail = shareRxFallbackDetail('remote-video-3', d, d.cap ? 12.5 : null);
            expect(validateCallEvent({ t: Date.now(), kind: 'share_rx_fallback', detail })).toEqual([]);
            expect(detail).toMatchObject(d.cap ? { from: 'top', to: 'low', action: 'down', hold_s: 20 } : { from: 'low', to: 'top', action: 'up', loss_pct: 0 });
        }
    });
});
