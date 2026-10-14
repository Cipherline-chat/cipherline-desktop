import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference cannot be mounted under vitest, so (like
 * shareFpsSurround.wiring.test.ts) this reads the source to pin that the three
 * ways a live share's quality changes - the Adjust-quality chips, the picker
 * opened mid-share, the hot swap onto a new source - all go through the one
 * applier (utils/shareLiveRetune.ts). The decisions are tested there.
 */
const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');

const body = (start: string, end: string): string => {
    const a = SC.indexOf(start);
    expect(a, start).toBeGreaterThan(-1);
    const b = SC.indexOf(end, a);
    expect(b, end).toBeGreaterThan(a);
    return SC.slice(a, b);
};

describe('one applier for every live-share quality change', () => {
    it('Adjust quality retunes through retuneLiveShare, then falls back to a republish', () => {
        const adj = body('const adjustScreenShareQuality = async', 'const tryHotSwapScreenShare');
        expect(adj).toContain('await retuneLiveShare(liveShareApplier(), current, resolution, frameRate)');
        expect(adj.indexOf('retuneLiveShare(')).toBeLessThan(adj.indexOf('await handleScreenShareSelect({'));
        // It no longer talks to the track itself.
        expect(adj).not.toContain('retuneScreenShareInPlace(');
    });

    it('the picker selection reaches the same retune BEFORE the hot swap / republish decision', () => {
        const start = body('const startScreenShareFrom = async', 'const swapped = await tryHotSwapScreenShare(');
        expect(start).toContain('await applyLiveSelection(liveShareApplier(), localParticipant.isScreenShareEnabled, currentShareRef.current, options)');
        expect(start.indexOf('applyLiveSelection(')).toBeGreaterThan(start.indexOf('const useNativeAudio'));
    });

    it('the hot swap applies the chosen quality with the same retune, at the paced capture rate, and records the share before the audio tail', () => {
        const swap = body('const tryHotSwapScreenShare = async', 'const reapplyShareSenderParams');
        expect(swap).toContain('frameRate: { max: captureFrameRateFor(options.frameRate) },');
        expect(swap).toContain('await applyQualityAfterSwap(liveShareApplier(), recorded)');
        expect(swap.indexOf('applyQualityAfterSwap(')).toBeLessThan(swap.indexOf('await stopNativeWindowAudio();'));
        // The old direct sender-param call survives only as the fallback when the retune is refused.
        expect(swap).toMatch(/if \(!retuned\) \{\s*try \{\s*await applyScreenShareSenderParams\(/);
        // ...and the swap no longer records the share itself after the audio restart.
        expect(swap).not.toContain('currentShareRef.current = recorded;');
    });

    it('the applier retunes the live track, then commits: current share, sender-param context, session, share_codec + share_clamp', () => {
        const ap = body('const liveShareApplier = (): LiveShareApplier => ({', 'const openScreenSharePicker');
        expect(ap).toContain('retuneScreenShareInPlace(track, resolution, frameRate, { step: shareResStepRef.current })');
        expect(ap).toContain('currentShareRef.current = next;');
        expect(ap).toContain('setCurrentShare(next);');
        expect(ap).toContain('updateScreenShareSession(next.sourceId, { requestedFps: next.frameRate, resolution: next.resolution });');
        expect(ap).toContain('shareParamsCtxRef.current = { options: next, codec };');
        expect(ap).toContain("logCallEvent('share_codec', ev.codec);");
        expect(ap).toContain("logCallEvent('share_clamp', ev.clamp);");
        expect(ap).toContain('cropActive: () => !!cropPipelineRef.current,');
    });

    it('republishes that must stay republishes are not intercepted: they pass the share\'s own options (no quality difference)', () => {
        // The stall / codec-swap / H.264-High fallbacks all republish { ...cur }.
        expect(SC.match(/republishShareRef\.current\?\.\(\{ \.\.\.cur(rent)? \}\)/g)?.length).toBeGreaterThanOrEqual(2);
        // ...and the matcher requires a quality difference, so an identical selection is 'other'.
        const util = fs.readFileSync(path.resolve(__dirname, '../utils/shareLiveRetune.ts'), 'utf8');
        expect(util).toContain('sameLiveCapture(cur, next) && qualityDiffers(cur, next) ? \'retune\' : \'other\'');
    });
});
