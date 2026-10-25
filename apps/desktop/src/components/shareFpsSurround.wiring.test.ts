import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference is a 5k-line component that cannot be mounted under
 * vitest, so - like e2eeActivationWiring.test.ts - this reads the source to pin
 * the WIRING of the 2026-10-13 screen-share work: the encoder-size clamp, the
 * single-screen crop publish, the black-screen watchdog and the instrumentation.
 * The decisions themselves are tested where they live (shareEncoderLimits,
 * shareLayout, shareCrop, shareHealth).
 */
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const SC = src('SidebarConference.tsx');
const CB = src('call/ControlBar.tsx');
const CP = src('CallPane.tsx');
const VV = src('VoiceVideoSettings.tsx');
const PICKER = src('ScreenSharePickerModal.tsx');

const count = (hay: string, needle: string | RegExp) =>
    typeof needle === 'string' ? hay.split(needle).length - 1 : (hay.match(needle)?.length ?? 0);

describe('encoder-size clamp reaches the capturer', () => {
    it('setScreenShareEnabled is handed the codec-clamped box, not the raw 8K "source" box', () => {
        expect(SC).toContain('const box = captureBoxFor(options.resolution, codec);');
        const call = SC.indexOf('await localParticipant.setScreenShareEnabled(true, {');
        expect(call).toBeGreaterThan(-1);
        const body = SC.slice(call, call + 400);
        expect(body).toContain('width: box.width,');
        expect(body).toContain('height: box.height,');
        expect(body).not.toContain('dims.width');
        expect(body).toContain('frameRate: captureFps,'); // 1.25x the target, unchanged
    });

    it('the mid-share paths are clamped too: hot swap by the live codec, in-place retune inside screenShare.ts', () => {
        expect(SC).toContain("const dims = captureBoxFor(options.resolution, asScreenShareCodec(lkTrack.codec) ?? 'vp8');");
        expect(src('../utils/screenShare.ts')).toContain("const dims = captureBoxFor(resolution, asScreenShareCodec(track.codec) ?? 'vp8');");
    });

    it('sender params are re-asserted with the fallback step and, for a cropped share, its size and box', () => {
        expect(SC).toContain('applyScreenShareSenderParams(sender, options.frameRate, maxBitrate, shareSenderParamOpts(codec, options))');
        expect(SC).toMatch(/sourceSize: out, box: captureBoxFor\(options\.resolution, codec\)/);
    });

    it('logs what the encoder was held to (share_clamp)', () => {
        expect(SC).toMatch(/logCallEvent\('share_clamp', \{\s*codec, cap_res: capRes, res: outRes, scale: plan\.scale/);
    });
});

describe('single-screen (cropped) publish', () => {
    it('publishes the generated track as the screen share: user-provided, source ScreenShare, the same publish options', () => {
        expect(SC).toContain('const croppedTrack = new LocalVideoTrack(pipe.track, undefined, true);');
        expect(SC).toContain('await localParticipant.publishTrack(croppedTrack, { source: Track.Source.ScreenShare, ...publishOptions });');
        // ...so installH264HighPreference (keyed on the publish source) and the
        // room's E2EE sender transform apply exactly as to a captured share.
        expect(src('../utils/screenShare.ts')).toContain("track?.source !== source || !wantHigh()");
    });

    it('is only taken for a slice layout on a runtime that has the breakout box; otherwise the whole display is shared', () => {
        expect(SC).toContain("const sliceLayout = wantsSlice && supportsCropPipeline() ? wantsSlice : null;");
        // (between them: the HDR screen branch, which publishes its own generated track - hdrSharePipeline.ts)
        expect(SC).toMatch(/if \(sliceLayout\) \{\s*await publishCroppedShare\(sliceLayout\);\s*\} else if \(hdrPipe\) \{[\s\S]{0,1500}?\} else \{\s*await localParticipant\.setScreenShareEnabled\(true,/);
    });

    it('asks the capturer for the display at native size (box far above any display) at the paced capture rate', () => {
        expect(SC).toContain('video: { width: 16384, height: 8640, frameRate: captureFps },');
    });

    it('the pipeline is stopped on every path that ends or restarts the share', () => {
        // toggle off, quick-share off, the "share is not enabled" effect, republish teardown, a failed start
        expect(count(SC, 'stopCropPipeline();')).toBeGreaterThanOrEqual(5);
        const failed = SC.indexOf('const reportShareStartError = (err: unknown): ShareStartOutcome => {');
        expect(SC.slice(failed, failed + 300)).toContain('stopCropPipeline();');
        // The not-enabled effect must not tear down a pipeline that a restart has just built.
        expect(SC).toMatch(/if \(!shareStartRef\.current\?\.starting\) \{\s*stopCropPipeline\(\);/);
    });

    it('a pipeline never goes through the hot swap or the in-place retune (they cannot rebuild it)', () => {
        expect(SC).toContain("if (cropPipelineRef.current || hdrPipelineRef.current || options.layout?.kind === 'slice') return false;");
        // The retune (Adjust quality, and a same-source picker selection) refuses a crop pipeline
        // in retuneLiveShare, which is the only caller of the in-place retune.
        expect(SC).toContain('if (await retuneLiveShare(liveShareApplier(), current, resolution, frameRate)) return;');
        expect(SC).toContain('cropActive: () => !!cropPipelineRef.current || !!hdrPipelineRef.current,');
        expect(src('../utils/shareLiveRetune.ts')).toContain('if (applier.cropActive()) return false;');
    });

    it('the layout survives a quality change, an audio toggle, a hot swap and a stall republish', () => {
        expect(count(SC, 'layout:     cur.layout,')).toBeGreaterThanOrEqual(1);
        // The in-place retune keeps the layout by spreading the live options (shareLiveRetune.ts);
        // only the republish fallback spells it out.
        expect(count(SC, 'layout:     current.layout,')).toBeGreaterThanOrEqual(1);
        expect(src('../utils/shareLiveRetune.ts')).toContain('applier.commit({ ...current, resolution, frameRate }, \'retune\');');
        expect(SC).toContain('layout:     sliceLayout ?? undefined,');
        expect(SC).toContain('republishShareRef.current?.({ ...cur });');
    });

    it('switching screens is live (setLayout), and to the whole display the encoder is scaled FIRST', () => {
        const fn = SC.indexOf('const switchShareLayout = async (layout: ShareLayout) => {');
        expect(fn).toBeGreaterThan(-1);
        const body = SC.slice(fn, fn + 2600);
        const whole = body.indexOf("if (layout.kind === 'whole') {");
        expect(body.indexOf('await reapplyShareSenderParams();', whole)).toBeLessThan(body.indexOf('pipe.setLayout(layout);', whole));
        expect(SC).toContain('onChangeShareLayout={switchShareLayout}');
        expect(CB).toContain('onClick={() => onChangeShareLayout(c.layout)}');
    });

    it('the picker option carries the layout and ControlBar offers choices only for an ultra-wide display', () => {
        expect(PICKER).toContain('layout?: ShareLayout;');
        expect(SC).toContain('shareLayoutChoices={layoutChoices(shareDisplayAspect)}');
    });
});

describe('black-screen safety net', () => {
    it('arms the watchdog for every share the H.264-High / H.265 watchers do not cover, and nothing else', () => {
        expect(SC).toMatch(/if \(!h264High && codec !== 'h265'\) \{\s*const wdSender = /);
        expect(count(SC, 'armEncoderWatchdog(options, codec, wdSender)')).toBe(1);
    });

    it('a stall steps the resolution down and republishes, tells the user, and logs it - never silent', () => {
        const fn = SC.indexOf('const handleEncoderStall = (');
        expect(fn).toBeGreaterThan(-1);
        const body = SC.slice(fn, fn + 1700);
        expect(body).toContain('decideStallAction(step)');
        expect(body).toContain("logCallEvent('share_fallback'");
        expect(body).toContain('toast.push({ kind: copy.kind, message: copy.message');
        expect(body).toContain('shareResStepRef.current = action.step;');
        expect(body).toContain('republishShareRef.current?.({ ...cur });');
        // the give-up branch toasts BEFORE returning
        expect(body.indexOf('toast.push(')).toBeLessThan(body.indexOf("if (action.kind !== 'resolution') return;"));
    });

    it('the fallback step is per source and survives the stall republish', () => {
        expect(SC).toContain('if (shareResStepSourceRef.current !== options.sourceId) {');
        expect(SC).toContain('step: shareResStepRef.current,');
    });
});

describe('instrumentation', () => {
    it('share_fps is sampled while sharing and re-sampled around focus changes', () => {
        expect(SC).toContain('new ShareStatsSampler({');
        expect(SC).toContain('subscribeWindowBackground(() => sampler.noteFocusChange())');
        expect(SC).toMatch(/logCallEvent\('share_fps', \{\s*src_fps, enc_fps, sent_fps, limit, enc, hw,\s*target: share\.frameRate, focus: d\.focus === true,\s*fg_state: fgLog\.fg_state, fg_exe: fgLog\.fg_exe, fg_cover: fgLog\.fg_cover,/);
    });

    it('the capture rate it reports is the capturer\'s (the display track\'s, not the generated one\'s)', () => {
        expect(SC).toContain('cropPipelineRef.current?.captureSettings() ?? hdrPipelineRef.current?.captureSettings() ?? track?.mediaStreamTrack?.getSettings()');
    });
});

describe('Windows boost and its setting', () => {
    it('ShareBoostGuard is mounted once per call, next to the gaming-video guard', () => {
        const a = CP.indexOf('<GamingVideoGuard />');
        const b = CP.indexOf('<ShareBoostGuard />');
        expect(a).toBeGreaterThan(-1);
        expect(b).toBeGreaterThan(a);
        expect(count(CP, '<ShareBoostGuard />')).toBe(1);
    });

    it('there is ONE setting: the existing While-gaming card, relabelled for calls and screen share', () => {
        expect(count(VV, '<GamingVideoSetting />')).toBe(1);
        expect(VV).not.toContain('ShareBoostSetting');
        expect(fs.existsSync(path.resolve(__dirname, 'settings/ShareBoostSetting.tsx'))).toBe(false);
        expect(fs.existsSync(path.resolve(__dirname, '../utils/shareBoostMode.ts'))).toBe(false);
        expect(src('settings/GamingVideoSetting.tsx')).toContain('GAMING_VIDEO_LABEL');
        expect(src('../utils/gamingVideoMode.ts')).toContain("GAMING_VIDEO_LABEL = 'Prioritize calls and screen share while gaming'");
    });
});
