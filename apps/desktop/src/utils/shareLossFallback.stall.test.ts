/**
 * capForStall: the decoder fell behind on the full layer (shareRxStallRecovery.ts).
 * No loss and no keyframe request, so observe() cannot tell it from a still screen,
 * and the recovery asks for the lighter copy directly. Reports cd4f4ce5, c704ba3e.
 */
import { describe, it, expect } from 'vitest';
import { ShareLossFallback, HOLD_MS_INITIAL, CLEAN_TICKS, NO_LOW_RETRY_MS, type ShareRxTick } from './shareLossFallback';

const TICK = 2000;
function driver() {
    const fb = new ShareLossFallback();
    let now = 0;
    const step = (o: Partial<Omit<ShareRxTick, 'now'>> = {}) => {
        now += TICK;
        return fb.observe({ now, lossPct: 0, frozen: false, keyframeAsked: false, wantsTop: true, layers: 2, packets: 900, frameShort: 1440, ...o });
    };
    const stall = (o: Partial<{ wantsTop: boolean; layers: number }> = {}) => fb.capForStall({ now, wantsTop: true, layers: 2, ...o });
    return { fb, step, stall, at: () => now, skip: (ms: number) => { now += ms; } };
}

describe('ShareLossFallback.capForStall', () => {
    it('observe() alone never trips on this stall: frozen, no loss, no keyframe request', () => {
        const d = driver();
        for (let i = 0; i < 15; i++) expect(d.step({ frozen: true }).changed).toBe(false);
        expect(d.fb.capped).toBe(false);
    });

    it('caps at once, with its own reason and the normal hold', () => {
        const d = driver();
        d.step();
        expect(d.stall()).toEqual({ cap: true, changed: true, reason: 'decoder_stall', holdMs: HOLD_MS_INITIAL });
        expect(d.fb.capped).toBe(true);
    });

    it('reports no change when already capped', () => {
        const d = driver();
        d.stall();
        expect(d.stall()).toEqual({ cap: true, changed: false });
    });

    it('nothing to fall back to: one layer, or the tile is on the low layer anyway', () => {
        const d = driver();
        expect(d.stall({ layers: 1 })).toEqual({ cap: false, changed: false });
        expect(d.stall({ wantsTop: false })).toEqual({ cap: false, changed: false });
        expect(d.fb.capped).toBe(false);
    });

    it('respects "Keep full quality"', () => {
        const d = driver();
        d.fb.optOut();
        expect(d.stall()).toEqual({ cap: false, changed: false });
    });

    it('respects the back-off after the lower layer did not arrive (the sharer has it off)', () => {
        const d = driver();
        d.step();
        d.stall();
        d.step({ packets: 0, frozen: true });
        expect(d.step({ packets: 0, frozen: true })).toMatchObject({ cap: false, changed: true, reason: 'no_low_layer' });
        expect(d.stall()).toEqual({ cap: false, changed: false });
        d.skip(NO_LOW_RETRY_MS);
        expect(d.stall()).toMatchObject({ cap: true, changed: true, reason: 'decoder_stall' });
    });

    it('doubles the hold when the full layer stalls again right after coming back', () => {
        const d = driver();
        d.step();
        d.stall();
        d.skip(HOLD_MS_INITIAL);
        let last = d.step({ frameShort: 720 });
        for (let i = 0; i < CLEAN_TICKS && !last.changed; i++) last = d.step({ frameShort: 720 });
        expect(last).toMatchObject({ changed: true, reason: 'recovered' });
        d.step();
        expect(d.stall()).toMatchObject({ reason: 'decoder_stall', holdMs: HOLD_MS_INITIAL * 2 });
    });

    it('a capped share still stalled is not "recovered", however clean the link looks', () => {
        const d = driver();
        d.step();
        d.stall();
        d.skip(HOLD_MS_INITIAL);
        for (let i = 0; i < CLEAN_TICKS * 2; i++) expect(d.step({ frozen: true, decoderStalled: true }).changed).toBe(false);
        expect(d.fb.capped).toBe(true);
        let last = d.step({ frameShort: 720 });
        for (let i = 0; i < CLEAN_TICKS && !last.changed; i++) last = d.step({ frameShort: 720 });
        expect(last).toMatchObject({ changed: true, reason: 'recovered' });
    });
});
