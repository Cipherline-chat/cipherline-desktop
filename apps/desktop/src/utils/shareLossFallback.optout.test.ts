import { describe, it, expect } from 'vitest';
import { ShareLossFallback, HOLD_MS_INITIAL, shareRxFallbackDetail, type ShareRxTick } from './shareLossFallback';
import { validateCallEvent } from './callEventLog';

/**
 * "Keep full quality" (the viewer's opt-out on the fallback notice) and what the
 * notice needs to know: whether the lighter copy is really on screen, and at what size.
 */
const TICK = 2000;

function driver() {
    const fb = new ShareLossFallback();
    let now = 0;
    const step = (o: Partial<Omit<ShareRxTick, 'now'>> = {}) => {
        now += TICK;
        return fb.observe({ now, lossPct: 0, frozen: false, keyframeAsked: false, wantsTop: true, layers: 2, ...o });
    };
    return { fb, step };
}

describe('ShareLossFallback — opt-out', () => {
    it('while capped: lifts the cap at once, with reason opt_out', () => {
        const d = driver();
        expect(d.step({ lossPct: 30 })).toMatchObject({ cap: true, changed: true });
        expect(d.fb.optOut()).toEqual({ cap: false, changed: true, reason: 'opt_out' });
        expect(d.fb.capped).toBe(false);
        expect(d.fb.optedOut).toBe(true);
        expect(d.fb.lowShowing).toBe(false);
    });

    it('never caps again, whatever the link does', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        d.fb.optOut();
        for (let i = 0; i < 200; i++) {
            expect(d.step({ lossPct: i % 2 ? 40 : 12, frozen: true, keyframeAsked: true, packets: 10 })).toEqual({ cap: false, changed: false });
        }
        expect(d.fb.capped).toBe(false);
    });

    it('while not capped: nothing changes now, and it still never caps', () => {
        const d = driver();
        expect(d.fb.optOut()).toEqual({ cap: false, changed: false });
        expect(d.step({ lossPct: 30 })).toEqual({ cap: false, changed: false });
        expect(d.step({ lossPct: 30 })).toEqual({ cap: false, changed: false });
    });

    it('is idempotent', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        expect(d.fb.optOut().changed).toBe(true);
        expect(d.fb.optOut()).toEqual({ cap: false, changed: false });
    });

    it('is per instance: a new share (a new ShareLossFallback) falls back as usual', () => {
        const a = driver();
        a.fb.optOut();
        const b = driver();
        expect(b.step({ lossPct: 30 })).toMatchObject({ cap: true, changed: true, reason: 'loss' });
    });

    it('the opt_out lift is a valid share_rx_fallback event (from/to)', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        const detail = shareRxFallbackDetail('remote-video-2', d.fb.optOut(), null);
        expect(detail).toMatchObject({ from: 'low', to: 'top', action: 'up', reason: 'opt_out' });
        expect(validateCallEvent({ t: Date.now(), kind: 'share_rx_fallback', detail })).toEqual([]);
    });
});

describe('ShareLossFallback — is the lighter copy on screen?', () => {
    it('not at the cap; yes once a smaller frame decodes, with that frame’s short side', () => {
        const d = driver();
        d.step({ frameShort: 1440, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1440, packets: 900 });   // cap
        expect(d.fb.capped).toBe(true);
        expect(d.fb.lowShowing).toBe(false);
        d.step({ lossPct: 20, frameShort: 1440, packets: 500 });   // full layer still draining
        expect(d.fb.lowShowing).toBe(false);
        expect(d.fb.lowShort).toBeNull();
        d.step({ frameShort: 720, packets: 300 });                 // the lighter copy
        expect(d.fb.lowShowing).toBe(true);
        expect(d.fb.lowShort).toBe(720);
        d.step({ frameShort: 718, packets: 300 });
        expect(d.fb.lowShort).toBe(720);                           // the first proof, not the latest frame
    });

    it('a frozen tick proves nothing', () => {
        const d = driver();
        d.step({ frameShort: 1080, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1080, packets: 900 });
        d.step({ frameShort: 720, packets: 300, frozen: true });
        expect(d.fb.lowShowing).toBe(false);
    });

    it('sizes unknown: delivered, but no number to quote', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        d.step({ packets: 300 });
        expect(d.fb.lowShowing).toBe(true);
        expect(d.fb.lowShort).toBeNull();
    });

    it('a lower layer that never arrives is never "showing", and the lift is no_low_layer', () => {
        const d = driver();
        d.step({ frameShort: 1080, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1080, packets: 900 });
        d.step({ packets: 0, frameShort: 1080 });
        expect(d.fb.lowShowing).toBe(false);
        expect(d.step({ packets: 0, frameShort: 1080 })).toMatchObject({ cap: false, reason: 'no_low_layer' });
        expect(d.fb.lowShowing).toBe(false);
    });

    it('a new cap starts unproved again', () => {
        const d = driver();
        d.step({ frameShort: 1080, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1080, packets: 900 });
        d.step({ frameShort: 720, packets: 300 });
        expect(d.fb.lowShowing).toBe(true);
        let r = d.step({ frameShort: 720, packets: 300 });
        for (let t = 0; t < HOLD_MS_INITIAL * 2 && !(r.changed && r.reason === 'recovered'); t += TICK) r = d.step({ frameShort: 720, packets: 300 });
        expect(r).toMatchObject({ cap: false, reason: 'recovered' });
        expect(d.fb.lowShowing).toBe(false);
        d.step({ frameShort: 1080, packets: 900 });
        d.step({ lossPct: 30, frameShort: 1080, packets: 900 });
        expect(d.fb.capped).toBe(true);
        expect(d.fb.lowShowing).toBe(false);
        expect(d.fb.lowShort).toBeNull();
    });
});
