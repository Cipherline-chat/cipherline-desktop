/**
 * The viewer's 2026-10-24 report (staging.174): capped to the lower layer with
 * reason 'freeze' at 0 % loss, then rx_video_health pli 47 / 46 / 55 per 10 s,
 * kf 0, capped:true for 30+ s — the sharer's lower layer was gated OFF
 * (software encoder), so every keyframe request went to an encoder that was
 * not running, and packets kept arriving so the "silence" lift never fired.
 */
import { describe, it, expect } from 'vitest';
import { ShareLossFallback, STUCK_LOW_TICKS, HOLD_MS_INITIAL, NO_LOW_RETRY_MS, type ShareRxTick } from './shareLossFallback';

const TICK = 2000;
function driver() {
    const fb = new ShareLossFallback();
    let now = 0;
    const step = (o: Partial<Omit<ShareRxTick, 'now'>> = {}) => {
        now += TICK;
        return fb.observe({ now, lossPct: 0, frozen: false, keyframeAsked: false, wantsTop: true, layers: 2, ...o });
    };
    return { fb, step, at: () => now };
}

describe('ShareLossFallback — capped onto a lower layer that never decodes', () => {
    it(`packets arrive, nothing decodes, keyframes asked for ${STUCK_LOW_TICKS} ticks → cap lifted (no_low_layer), long before the hold`, () => {
        const d = driver();
        // The 'freeze' trip: frozen + keyframe asked at 0 % loss, two ticks.
        d.step({ frozen: true, keyframeAsked: true, packets: 50 });
        expect(d.step({ frozen: true, keyframeAsked: true, packets: 50 })).toMatchObject({ cap: true, reason: 'freeze' });
        let last = d.step({ frozen: true, keyframeAsked: true, packets: 40 });
        for (let i = 1; i < STUCK_LOW_TICKS && !last.changed; i++) last = d.step({ frozen: true, keyframeAsked: true, packets: 40 });
        expect(last).toEqual({ cap: false, changed: true, reason: 'no_low_layer' });
        expect(d.at()).toBeLessThan(HOLD_MS_INITIAL);
    });

    it('and the lower layer is not retried for the back-off', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        for (let i = 0; i < STUCK_LOW_TICKS; i++) d.step({ frozen: true, keyframeAsked: true, packets: 40 });
        expect(d.fb.capped).toBe(false);
        const t0 = d.at();
        while (d.at() - t0 < NO_LOW_RETRY_MS - TICK) expect(d.step({ lossPct: 30 }).cap).toBe(false);
    });

    it('the SFU switch-over (a couple of frozen ticks, then frames) keeps the cap', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        d.step({ frozen: true, keyframeAsked: true, packets: 40 });
        d.step({ frozen: true, keyframeAsked: true, packets: 40 });
        expect(d.step({ packets: 300, frameShort: 720 })).toEqual({ cap: true, changed: false });
        expect(d.fb.capped).toBe(true);
    });

    it('a still screen on the lower layer (frozen but nobody asking for a keyframe) is fine', () => {
        const d = driver();
        d.step({ lossPct: 30 });
        for (let i = 0; i < 6; i++) expect(d.step({ frozen: true, keyframeAsked: false, packets: 5 }).cap).toBe(true);
    });
});
