import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference cannot be mounted under vitest, so (like
 * shareLiveRetune.wiring.test.ts) this reads the source. The decisions and the
 * wait itself are tested in utils/shareFirstFrame.test.ts and
 * utils/shareLiveRetune.test.ts; this pins that the component uses them.
 *
 * Owner report 2026-10-31: changing quality or toggling "disable audio" on a
 * whole-screen share killed the renderer (0xC0000005); every crash logged
 * share_clamp cap_res=3840x2160 on a 2560x1440 display.
 */
const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');

const from = (start: string, len: number): string => {
    const a = SC.indexOf(start);
    expect(a, start).toBeGreaterThan(-1);
    return SC.slice(a, a + len);
};

describe('a fresh publish waits for the capture\'s first real frame before anything is published', () => {
    it('goes through publishScreenShareSettled, not setScreenShareEnabled(true, ...) (which publishes the constraint box as the size)', () => {
        expect(SC).toContain('settledStart = await publishScreenShareSettled(localParticipant, {');
        expect(SC).not.toMatch(/localParticipant\.setScreenShareEnabled\(true/);
    });

    it('the pre-publish share_clamp (phase pre) is logged from onSettled, so it survives a crash during the publish', () => {
        // (logged FIRST, then - through the Wayland portal only - a closed chooser throws, so the record is there either way)
        expect(SC).toMatch(/onSettled: st => \{\s*logCallEvent\('share_clamp', \{ codec, phase: 'pre', \.\.\.settleEventDetails\(st\) \}\);/);
    });

    it('the post-publish share_clamp carries ask / first_frame / settle and plans the encode from the first frame', () => {
        const post = from('const sent = sliceStartSize ?? settledStart?.first ?? capSize;', 1800);
        expect(post).toContain("phase: 'post'");
        expect(post).toContain('ask: fmtSize(settledStart.asked), first_frame: fmtSize(settledStart.first)');
    });

    it('the sender params use the first frame size (not the track\'s possibly-false one) unless the share is cropped / HDR', () => {
        expect(SC).toContain('const realSize = !cropPipelineRef.current && !hdrPipelineRef.current ? settledStart?.first : null;');
    });

    it('the old share is torn down BEFORE the new capture exists (no overlap of the two encoders)', () => {
        const s = from('const startScreenShareFrom = async (', 45000);
        const teardown = s.indexOf('await localParticipant.setScreenShareEnabled(false);');
        const publish = s.indexOf('await publishScreenShareSettled(localParticipant, {');
        expect(teardown).toBeGreaterThan(0);
        expect(publish).toBeGreaterThan(teardown);
    });
});

describe('the hot swap settles the new capture before replaceTrack', () => {
    it('settles, hands the share_clamp the handshake, and lets go in a finally', () => {
        const b = from('const tryHotSwapScreenShare = async (', 14000);
        const settle = b.indexOf('settledSwap = await settleCaptureSize(newMs, capBox, portalCap ? PORTAL_FIRST_FRAME_WAIT : {});');
        expect(settle).toBeGreaterThan(0);
        expect(b.indexOf('await lkTrack.replaceTrack(newMs')).toBeGreaterThan(settle);
        expect(b).toContain('shareSettleExtraRef.current = settleEventDetails(settledSwap);');
        expect(b).toMatch(/\} finally \{\s*settledSwap\?\.release\(\);/);
    });
});

describe('"Disable / Enable audio" does not touch the video', () => {
    it('toggleScreenShareAudio still hands a same-source selection to handleScreenShareSelect...', () => {
        const t = from('const toggleScreenShareAudio = async () => {', 600);
        expect(t).toContain('audio:      !cur.audio,');
        expect(t).toContain('await handleScreenShareSelect({');
    });

    it('...which routes an audio-only change to applyAudioOnlyChange BEFORE the retune, the hot swap and the teardown', () => {
        const s = from('const startScreenShareFrom = async (', 45000);
        const audio = s.indexOf('isAudioOnlyChange(currentShareRef.current, options)');
        expect(audio).toBeGreaterThan(0);
        expect(s.indexOf('applyAudioOnlyChange(options, useNativeAudio, nativeMode)')).toBeGreaterThan(audio);
        expect(s.indexOf('if (!fresh && await applyLiveSelection(')).toBeGreaterThan(audio);
        expect(s.indexOf('await tryHotSwapScreenShare(')).toBeGreaterThan(audio);
        // loopback audio can only be turned ON by a new capture: that stays on the old route
        expect(s).toContain('&& (!options.audio || useNativeAudio)');
    });

    it('applyAudioOnlyChange never acquires, swaps or unpublishes the VIDEO', () => {
        const a = from('const applyAudioOnlyChange = async (', 3200);
        const end = a.indexOf('\n    };\n');
        expect(end).toBeGreaterThan(0);
        const body = a.slice(0, end);
        expect(body).toContain("await stopNativeWindowAudio('toggle');");
        expect(body).toContain('startNativeWindowAudio(nativeMode, options.sourceId, options.appAudio?.handle)');
        for (const forbidden of ['getDisplayMedia', 'replaceTrack', 'setScreenShareEnabled', 'Track.Source.ScreenShare)', 'publishScreenShareSettled', 'unpublishTrack(ssPub']) {
            expect(body, forbidden).not.toContain(forbidden);
        }
    });

    it('audio + a quality change together is a fresh publish on a hardware encoder', () => {
        const fresh = from('const fresh = !!startOpts', 900);
        expect(fresh).toContain('audioPlusQualityNeedsFresh(currentShareRef.current, options, liveShareIsHardware())');
    });
});
