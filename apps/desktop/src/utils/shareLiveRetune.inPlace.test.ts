import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { liveFrameUnchanged, resolutionChangeNeedsFresh, retuneLiveShare, type LiveShareApplier } from './shareLiveRetune';
import { captureBoxFor } from './screenShare';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

const SRC: ScreenShareOptions = { sourceId: 'screen:0:0', resolution: 'source', frameRate: 60, audio: true };
const opt = (over: Partial<ScreenShareOptions> = {}): ScreenShareOptions => ({ ...SRC, ...over });
const box = (r: ScreenShareOptions['resolution']) => captureBoxFor(r, 'h265');

describe('liveFrameUnchanged: a resolution change that provably leaves the encoder\'s frames the same size', () => {
    const live1440 = { width: 2560, height: 1440 };
    it('native 1440p screen on "source": a 1440p or 4K preset changes nothing the encoder sees', () => {
        expect(liveFrameUnchanged(live1440, box('source'), box('1440p'))).toBe(true);
        expect(liveFrameUnchanged(live1440, box('source'), box('source'))).toBe(true);
    });
    it('...but a smaller box (1080p) does change the frames', () => {
        expect(liveFrameUnchanged(live1440, box('source'), box('1080p'))).toBe(false);
    });
    it('a capture that touches the CURRENT box in either dimension might be clamped by it: not proven', () => {
        // 1080p preset on a 1440p screen delivers 1920x1080: touching the box, so going to "source" WOULD change the size
        expect(liveFrameUnchanged({ width: 1920, height: 1080 }, box('1080p'), box('source'))).toBe(false);
        // an ultra-wide clamped in width only
        expect(liveFrameUnchanged({ width: 1920, height: 804 }, box('1080p'), box('source'))).toBe(false);
    });
    it('unknown / empty capture sizes are never proof', () => {
        expect(liveFrameUnchanged(null, box('source'), box('1440p'))).toBe(false);
        expect(liveFrameUnchanged(undefined, box('source'), box('1440p'))).toBe(false);
        expect(liveFrameUnchanged({}, box('source'), box('1440p'))).toBe(false);
        expect(liveFrameUnchanged({ width: 0, height: 0 }, box('source'), box('1440p'))).toBe(false);
    });
});

describe('resolutionChangeNeedsFresh with a proven same-size change', () => {
    it('hardware encoder: fresh unless the frame size is unchanged', () => {
        expect(resolutionChangeNeedsFresh(SRC, opt({ resolution: '1440p' }), true)).toBe(true);
        expect(resolutionChangeNeedsFresh(SRC, opt({ resolution: '1440p' }), true, true)).toBe(false);
    });
    it('the proof never rescues a different SOURCE (that is sourceSwapNeedsFresh\'s call) and never turns software into fresh', () => {
        expect(resolutionChangeNeedsFresh(SRC, opt({ sourceId: 'screen:1:0', resolution: '1440p' }), true, true)).toBe(false);
        expect(resolutionChangeNeedsFresh(SRC, opt({ resolution: '1440p' }), false, false)).toBe(false);
    });
});

describe('retuneLiveShare on a hardware encoder', () => {
    const make = (frameUnchanged: boolean | undefined) => {
        const retune = vi.fn(async () => true);
        const commit = vi.fn();
        const a: LiveShareApplier = {
            cropActive: () => false, hardwareEncoder: () => true, retune, commit,
            ...(frameUnchanged === undefined ? {} : { frameUnchanged: () => frameUnchanged }),
        };
        return { a, retune, commit };
    };
    it('retunes IN PLACE (no republish, so no gap) when the frame size is proven unchanged', async () => {
        const x = make(true);
        expect(await retuneLiveShare(x.a, SRC, '1440p', 60)).toBe(true);
        expect(x.retune).toHaveBeenCalledWith('1440p', 60);
        expect(x.commit).toHaveBeenCalledWith(opt({ resolution: '1440p' }), 'retune');
    });
    it('declines (the caller republishes fresh, as before) when the change is not proven', async () => {
        const x = make(false);
        expect(await retuneLiveShare(x.a, SRC, '1440p', 60)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });
    it('NEGATIVE CONTROL: an applier that cannot say (no frameUnchanged) behaves exactly as before the change', async () => {
        const x = make(undefined);
        expect(await retuneLiveShare(x.a, SRC, '1440p', 60)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });
    it('a frame-rate-only change was always in place and still is', async () => {
        const x = make(false);
        expect(await retuneLiveShare(x.a, SRC, 'source', 90)).toBe(true);
    });
});

describe('wiring: both routes ask the same question', () => {
    const SC = fs.readFileSync(path.resolve(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('the Adjust-quality applier and the picker\'s fresh-vs-retune decision both use liveFrameUnchangedFor', () => {
        expect(SC).toContain('frameUnchanged: liveFrameUnchangedFor,');
        expect(SC).toMatch(/resolutionChangeNeedsFresh\(currentShareRef\.current, options, liveShareIsHardware\(\),\s*!!currentShareRef\.current && liveFrameUnchangedFor\(currentShareRef\.current, options\)\)/);
    });
    it('it never applies on the portal or the crop / HDR pipelines', () => {
        const fn = SC.slice(SC.indexOf('const liveFrameUnchangedFor ='), SC.indexOf('const liveShareApplier ='));
        expect(fn).toContain('viaPortalRef.current || cropPipelineRef.current || hdrPipelineRef.current');
    });
});
