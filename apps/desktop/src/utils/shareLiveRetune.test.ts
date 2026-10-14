import { describe, it, expect, vi } from 'vitest';
import {
    retuneLiveShare, applyLiveSelection, applyQualityAfterSwap, routeLiveSelection,
    sameLiveCapture, sameShareLayout, qualityDiffers, qualityEventDetails,
    type LiveShareApplier,
} from './shareLiveRetune';
import { validateCallEvent } from './callEventLog';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

const LIVE: ScreenShareOptions = { sourceId: 'screen:0:0', resolution: '1080p', frameRate: 30, audio: true };
const opt = (over: Partial<ScreenShareOptions> = {}): ScreenShareOptions => ({ ...LIVE, ...over });

/** A spy applier. `retune` is the stand-in for retuneScreenShareInPlace on the live track. */
function applier(over: Partial<{ crop: boolean; retuneOk: boolean; retuneThrows: boolean }> = {}) {
    const retune = vi.fn(async (_res: ScreenShareOptions['resolution'], _fps: ScreenShareOptions['frameRate']) => {
        if (over.retuneThrows) throw new Error('overconstrained');
        return over.retuneOk ?? true;
    });
    const commit = vi.fn();
    const a: LiveShareApplier = { cropActive: () => over.crop ?? false, retune, commit };
    return { a, retune, commit };
}

describe('"Adjust quality" and the mid-share picker use the SAME retune', () => {
    it('Adjust quality: retunes the live track with the new resolution/fps, then commits', async () => {
        const x = applier();
        expect(await retuneLiveShare(x.a, LIVE, '1440p', 90)).toBe(true);
        expect(x.retune).toHaveBeenCalledTimes(1);
        expect(x.retune).toHaveBeenCalledWith('1440p', 90);
        expect(x.commit).toHaveBeenCalledWith(opt({ resolution: '1440p', frameRate: 90 }), 'retune');
    });

    it('picker, SAME source, new resolution and fps: calls that very retune with the same arguments, and commits identically', async () => {
        const chips = applier();
        await retuneLiveShare(chips.a, LIVE, '1440p', 90);
        const picker = applier();
        const handled = await applyLiveSelection(picker.a, true, LIVE, opt({ resolution: '1440p', frameRate: 90 }));
        expect(handled).toBe(true);
        expect(picker.retune.mock.calls).toEqual(chips.retune.mock.calls);
        expect(picker.commit.mock.calls).toEqual(chips.commit.mock.calls);
    });

    it('picker, SAME source, only the frame rate (or only the resolution) changed, is enough', async () => {
        const fps = applier();
        expect(await applyLiveSelection(fps.a, true, LIVE, opt({ frameRate: 60 }))).toBe(true);
        expect(fps.retune).toHaveBeenCalledWith('1080p', 60);
        const res = applier();
        expect(await applyLiveSelection(res.a, true, LIVE, opt({ resolution: '720p' }))).toBe(true);
        expect(res.retune).toHaveBeenCalledWith('720p', 30);
    });

    it('picker, DIFFERENT source: not retuned in place (it is a source change) - the hot swap then applies the quality through the same retune', async () => {
        const x = applier();
        const next = opt({ sourceId: 'screen:1:0', resolution: '1440p', frameRate: 90 });
        expect(await applyLiveSelection(x.a, true, LIVE, next)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
        expect(x.commit).not.toHaveBeenCalled();
        // ...after the new capture is on the sender:
        expect(await applyQualityAfterSwap(x.a, next)).toBe(true);
        expect(x.retune).toHaveBeenCalledTimes(1);
        expect(x.retune).toHaveBeenCalledWith('1440p', 90);
        expect(x.commit).toHaveBeenCalledWith(next, 'swap');
    });

    it('a swap whose retune is refused (or throws) still commits - the swap is live - and reports false so the caller applies the direct fallback', async () => {
        for (const over of [{ retuneOk: false }, { retuneThrows: true }]) {
            const x = applier(over);
            const next = opt({ sourceId: 'window:42:0', resolution: '720p', frameRate: 60 });
            expect(await applyQualityAfterSwap(x.a, next)).toBe(false);
            expect(x.commit).toHaveBeenCalledWith(next, 'swap');
        }
    });
});

describe('what is NOT a quality retune (negative controls)', () => {
    it('nothing changed (a stall / codec republish passes the share\'s own options): not matched, so the republish still happens', async () => {
        const x = applier();
        expect(await applyLiveSelection(x.a, true, LIVE, { ...LIVE })).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
        expect(routeLiveSelection(true, LIVE, { ...LIVE })).toBe('other');
    });

    it('an audio toggle (same source, same quality) is not a retune', async () => {
        const x = applier();
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ audio: false }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('audio flipped AND quality changed together goes to the full path, which applies both', async () => {
        const x = applier();
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ audio: false, frameRate: 60 }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('a layout change (single screen of an ultra-wide) is not a retune', async () => {
        const x = applier();
        const slice = { kind: 'slice', count: 3, index: 1 } as const;
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ layout: slice, frameRate: 60 }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('no share live yet (a fresh start), or no recorded share: never a retune', async () => {
        const x = applier();
        expect(await applyLiveSelection(x.a, false, LIVE, opt({ frameRate: 60 }))).toBe(false);
        expect(await applyLiveSelection(x.a, true, null, opt({ frameRate: 60 }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('a cropped (single-screen) share is never retuned in place: it must be rebuilt', async () => {
        const x = applier({ crop: true });
        expect(await retuneLiveShare(x.a, LIVE, '1440p', 90)).toBe(false);
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ frameRate: 60 }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
        expect(x.commit).not.toHaveBeenCalled();
    });

    it('a retune the platform refuses changes nothing and says false, so the caller republishes', async () => {
        const x = applier({ retuneOk: false });
        expect(await retuneLiveShare(x.a, LIVE, '1440p', 90)).toBe(false);
        expect(x.commit).not.toHaveBeenCalled();
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ frameRate: 60 }))).toBe(false);
        expect(x.commit).not.toHaveBeenCalled();
    });
});

describe('same-capture predicates', () => {
    it('layout: undefined == whole; slices compare by count and index', () => {
        expect(sameShareLayout(undefined, undefined)).toBe(true);
        expect(sameShareLayout(undefined, { kind: 'whole' })).toBe(true);
        expect(sameShareLayout({ kind: 'slice', count: 3, index: 0 }, { kind: 'slice', count: 3, index: 0 })).toBe(true);
        expect(sameShareLayout({ kind: 'slice', count: 3, index: 0 }, { kind: 'slice', count: 3, index: 1 })).toBe(false);
        expect(sameShareLayout({ kind: 'slice', count: 3, index: 0 }, undefined)).toBe(false);
    });

    it('sameLiveCapture needs the same source, layout and audio; qualityDiffers is res or fps', () => {
        expect(sameLiveCapture(LIVE, opt({ resolution: '720p' }))).toBe(true);
        expect(sameLiveCapture(LIVE, opt({ sourceId: 'screen:0:1' }))).toBe(false);
        expect(sameLiveCapture(LIVE, opt({ audio: false }))).toBe(false);
        expect(qualityDiffers(LIVE, LIVE)).toBe(false);
        expect(qualityDiffers(LIVE, opt({ frameRate: 60 }))).toBe(true);
        expect(qualityDiffers(LIVE, opt({ resolution: '480p' }))).toBe(true);
    });
});

describe('share_codec / share_clamp after a retune are the events a publish writes', () => {
    const base = {
        codec: 'h264' as const, h264High: true, hardware: true, lighterCopy: false,
        next: { resolution: '1440p' as const, frameRate: 90 as const }, how: 'retune' as const,
        capture: { width: 2560, height: 1440 }, step: 0, layout: 'whole' as const,
    };

    it('share_codec carries the same keys as the publish-time event', () => {
        const { codec } = qualityEventDetails(base);
        expect(Object.keys(codec).sort()).toEqual(['codec', 'fps', 'hardware', 'lighter_copy', 'profile', 'reason', 'res'].sort());
        expect(codec).toMatchObject({ codec: 'h264', profile: 'high', hardware: true, res: '1440p', fps: 90, reason: 'retune' });
    });

    it('share_clamp carries the same keys as the publish-time event, with the encoder-size plan', () => {
        const { clamp } = qualityEventDetails(base);
        expect(Object.keys(clamp).sort()).toEqual(['cap_res', 'codec', 'layout', 'over', 'res', 'scale', 'step'].sort());
        expect(clamp).toMatchObject({ codec: 'h264', cap_res: '2560x1440', res: '2560x1440', scale: 1, layout: 'whole', over: false });
    });

    it('an over-limit capture is reported as scaled (the clamp is honest, not a copy of the capture)', () => {
        const { clamp } = qualityEventDetails({ ...base, codec: 'vp8', capture: { width: 7680, height: 1440 } });
        expect(clamp.cap_res).toBe('7680x1440');
        expect(Number(clamp.scale)).toBeGreaterThan(1);
    });

    it('a swap says so in share_codec.reason, and an unreadable capture leaves the sizes empty rather than inventing them', () => {
        const { codec, clamp } = qualityEventDetails({ ...base, how: 'swap', capture: undefined, codec: undefined });
        expect(codec.reason).toBe('source-swap');
        expect(clamp).toMatchObject({ codec: 'none', cap_res: '', res: '' });
    });

    it('both are valid call events (keys, value types, <= 11 keys)', () => {
        const { codec, clamp } = qualityEventDetails(base);
        expect(validateCallEvent({ t: Date.now(), kind: 'share_codec', detail: codec })).toEqual([]);
        expect(validateCallEvent({ t: Date.now(), kind: 'share_clamp', detail: clamp })).toEqual([]);
    });
});
