import { describe, it, expect, vi } from 'vitest';
import {
    retuneLiveShare, applyLiveSelection, applyQualityAfterSwap, routeLiveSelection,
    sameLiveCapture, sameShareLayout, qualityDiffers, qualityEventDetails,
    resolutionChangeNeedsFresh, sourceSwapNeedsFresh, isAudioOnlyChange, audioPlusQualityNeedsFresh,
    type LiveShareApplier,
} from './shareLiveRetune';
import { validateCallEvent } from './callEventLog';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

const LIVE: ScreenShareOptions = { sourceId: 'screen:0:0', resolution: '1080p', frameRate: 30, audio: true };
const opt = (over: Partial<ScreenShareOptions> = {}): ScreenShareOptions => ({ ...LIVE, ...over });

/** A spy applier. `retune` is the stand-in for retuneScreenShareInPlace on the live track. */
function applier(over: Partial<{ crop: boolean; retuneOk: boolean; retuneThrows: boolean; hardware: boolean }> = {}) {
    const retune = vi.fn(async (_res: ScreenShareOptions['resolution'], _fps: ScreenShareOptions['frameRate']) => {
        if (over.retuneThrows) throw new Error('overconstrained');
        return over.retuneOk ?? true;
    });
    const commit = vi.fn();
    const a: LiveShareApplier = {
        cropActive: () => over.crop ?? false, retune, commit,
        ...(over.hardware !== undefined ? { hardwareEncoder: () => over.hardware as boolean } : {}),
    };
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

// Report 45a5e136 (1.0.24-staging.179, Windows, RTX 2080 Ti, H.264 High + H.265
// via Media Foundation): "Changed from 1080p screenshare to source and it
// crashed". The call log shows the pattern twice in one session:
//   share_codec reason=retune res=1080p  (H.265 share, source -> 1080p in place)
//   share_codec_drift published=h265 sent=vp8      <- 2 s later, the HW encoder
//                                                     could not be re-opened at the new size
//   share_codec reason=retune res=source (H.264 High share, 1080p -> 3840x2160)
//   renderer:gone reason=crashed exit=-1073741819   <- 0.2 s later (0xC0000005)
// An in-place resolution change makes libwebrtc re-open the HARDWARE encoder at a
// new size while frames are in flight; a fresh publish builds a new encoder.
describe('a resolution change on a HARDWARE encoder is a fresh publish, never an in-place retune', () => {
    it('1080p -> source on a hardware encoder: not retuned, nothing committed (the caller publishes fresh)', async () => {
        const x = applier({ hardware: true });
        expect(await retuneLiveShare(x.a, LIVE, 'source', 90)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
        expect(x.commit).not.toHaveBeenCalled();
    });

    it('source -> 1080p on a hardware encoder (the H.265 -> VP8 drift): the same', async () => {
        const x = applier({ hardware: true });
        const live = opt({ resolution: 'source', frameRate: 90 });
        expect(await retuneLiveShare(x.a, live, '1080p', 90)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('resolution AND frame rate changed together on hardware: still fresh', async () => {
        const x = applier({ hardware: true });
        expect(await retuneLiveShare(x.a, LIVE, '1440p', 90)).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
    });

    it('the picker opened mid-share for the same source takes the same rule', async () => {
        const x = applier({ hardware: true });
        expect(await applyLiveSelection(x.a, true, LIVE, opt({ resolution: 'source', frameRate: 90 }))).toBe(false);
        expect(x.retune).not.toHaveBeenCalled();
        expect(x.commit).not.toHaveBeenCalled();
    });

    it('negative control: a FRAME-RATE-only change on hardware keeps the capture size, so it still retunes in place', async () => {
        const x = applier({ hardware: true });
        expect(await retuneLiveShare(x.a, LIVE, '1080p', 60)).toBe(true);
        expect(x.retune).toHaveBeenCalledWith('1080p', 60);
        expect(x.commit).toHaveBeenCalledWith(opt({ frameRate: 60 }), 'retune');
    });

    it('negative control: a resolution change on a SOFTWARE encoder (or one that cannot say) still retunes in place', async () => {
        for (const over of [{ hardware: false }, {}]) {
            const x = applier(over);
            expect(await retuneLiveShare(x.a, LIVE, '1440p', 90)).toBe(true);
            expect(x.retune).toHaveBeenCalledWith('1440p', 90);
        }
    });

    it('negative control: the post-swap quality application is untouched (the new capture is already on the sender)', async () => {
        const x = applier({ hardware: true });
        const next = opt({ sourceId: 'screen:1:0', resolution: '1440p', frameRate: 90 });
        expect(await applyQualityAfterSwap(x.a, next)).toBe(true);
        expect(x.retune).toHaveBeenCalledWith('1440p', 90);
    });

    it('resolutionChangeNeedsFresh: same capture + different resolution + hardware only', () => {
        expect(resolutionChangeNeedsFresh(LIVE, opt({ resolution: 'source' }), true)).toBe(true);
        expect(resolutionChangeNeedsFresh(LIVE, opt({ resolution: 'source' }), false)).toBe(false);
        expect(resolutionChangeNeedsFresh(LIVE, opt({ frameRate: 60 }), true)).toBe(false);
        expect(resolutionChangeNeedsFresh(LIVE, opt({ sourceId: 'screen:1:0', resolution: 'source' }), true)).toBe(false);
        expect(resolutionChangeNeedsFresh(null, opt({ resolution: 'source' }), true)).toBe(false);
    });
});

// Report abb0f871 (1.0.24-staging.180, RTX 2080 Ti): a hot swap from a WGC window
// share onto the DXGI screen on a live H.264 High hardware encoder -
//   share_codec codec=h264 reason=source-swap  (cap_res 3840x2160 on a 2560x1440 display)
//   renderer:gone reason=crashed exit=-1073741819   <- 0.2 s later (0xC0000005)
// and report dd3e84e3 (same PC, an H.265 screen share swapped onto a window):
//   share_codec codec=h265 reason=source-swap
//   share_codec_drift published=h265 sent=h264 enc=OpenH264   <- 4 s later; H.265 then
//                                                              latched off for the session
// replaceTrack() onto a running HARDWARE encoder hands it frames from a different
// capturer / size, the same in-flight re-open that resolutionChangeNeedsFresh
// already keeps off a resolution change. A different source on a hardware encoder
// is therefore a fresh publish (new sender, new encoder).
describe('a SOURCE swap on a HARDWARE encoder is a fresh publish, never a hot swap', () => {
    it('window -> screen and screen -> window on hardware: fresh', () => {
        const win = opt({ sourceId: 'window:4521:0', resolution: 'source', frameRate: 90 });
        const screen = opt({ sourceId: 'screen:1:0', resolution: 'source', frameRate: 90 });
        expect(sourceSwapNeedsFresh(win, screen, true)).toBe(true);
        expect(sourceSwapNeedsFresh(screen, win, true)).toBe(true);
    });

    it('another screen, with the quality changed at the same time: still fresh', () => {
        expect(sourceSwapNeedsFresh(LIVE, opt({ sourceId: 'screen:1:0', resolution: '1440p', frameRate: 90 }), true)).toBe(true);
    });

    it('negative control: a SOFTWARE encoder re-opens cheaply and safely, so the hot swap stays', () => {
        expect(sourceSwapNeedsFresh(LIVE, opt({ sourceId: 'screen:1:0' }), false)).toBe(false);
    });

    it('negative control: the same source (audio toggle, quality change) is not a source swap', () => {
        expect(sourceSwapNeedsFresh(LIVE, opt({ audio: false }), true)).toBe(false);
        expect(sourceSwapNeedsFresh(LIVE, opt({ resolution: 'source' }), true)).toBe(false);
        expect(sourceSwapNeedsFresh(LIVE, LIVE, true)).toBe(false);
    });

    it('negative control: no live share means nothing to swap', () => {
        expect(sourceSwapNeedsFresh(null, opt({ sourceId: 'screen:1:0' }), true)).toBe(false);
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

// Owner report 2026-10-31: toggling "disable audio" on a whole-screen share killed the
// renderer. The toggle republishes the SAME source with the opposite audio flag; that is
// neither a quality change (the retune needs the same audio: routeLiveSelection says
// 'other') nor a source swap (sourceSwapNeedsFresh compares source ids), so it fell to the
// hot swap - a second capture of the same screen replaceTrack()ed onto a running hardware
// encoder. An audio-only change must not touch the video at all.
describe('an AUDIO-only change is not a video change', () => {
    it('isAudioOnlyChange: same source, layout, resolution and fps; only audio differs', () => {
        expect(isAudioOnlyChange(LIVE, opt({ audio: false }))).toBe(true);
        expect(isAudioOnlyChange(opt({ audio: false }), LIVE)).toBe(true);
    });

    it('negative controls: nothing else qualifies', () => {
        expect(isAudioOnlyChange(LIVE, LIVE)).toBe(false);                                        // nothing changed
        expect(isAudioOnlyChange(LIVE, opt({ audio: false, resolution: 'source' }))).toBe(false); // quality too
        expect(isAudioOnlyChange(LIVE, opt({ audio: false, frameRate: 60 }))).toBe(false);
        expect(isAudioOnlyChange(LIVE, opt({ audio: false, sourceId: 'screen:1:0' }))).toBe(false);
        expect(isAudioOnlyChange(LIVE, opt({ audio: false, layout: { kind: 'slice', count: 3, index: 0 } }))).toBe(false);
        expect(isAudioOnlyChange(null, opt({ audio: false }))).toBe(false);
    });

    it('the audio toggle is exactly the selection that used to reach the hot swap: no retune, no fresh rule, not "retune" routed', () => {
        const toggle = opt({ audio: !LIVE.audio });
        expect(routeLiveSelection(true, LIVE, toggle)).toBe('other');
        expect(sourceSwapNeedsFresh(LIVE, toggle, true)).toBe(false);
        expect(resolutionChangeNeedsFresh(LIVE, toggle, true)).toBe(false);
        // ...and it is now recognised before any of them
        expect(isAudioOnlyChange(LIVE, toggle)).toBe(true);
    });

    it('audio + quality in ONE selection: a fresh publish on hardware, the hot swap stays on software', () => {
        const both = opt({ audio: false, resolution: '1440p' });
        expect(audioPlusQualityNeedsFresh(LIVE, both, true)).toBe(true);
        expect(audioPlusQualityNeedsFresh(LIVE, opt({ audio: false, frameRate: 60 }), true)).toBe(true);
        expect(audioPlusQualityNeedsFresh(LIVE, both, false)).toBe(false);
    });

    it('negative controls for audio + quality: audio alone, quality alone, another source, no share', () => {
        expect(audioPlusQualityNeedsFresh(LIVE, opt({ audio: false }), true)).toBe(false);
        expect(audioPlusQualityNeedsFresh(LIVE, opt({ resolution: '1440p' }), true)).toBe(false);
        expect(audioPlusQualityNeedsFresh(LIVE, opt({ audio: false, sourceId: 'screen:1:0' }), true)).toBe(false); // sourceSwapNeedsFresh's
        expect(audioPlusQualityNeedsFresh(null, opt({ audio: false, resolution: '1440p' }), true)).toBe(false);
    });
});

describe('a hot swap\'s share_clamp can carry the size handshake', () => {
    it('extra keys are merged into the clamp event and still validate', () => {
        const ev = qualityEventDetails({
            codec: 'h265', h264High: false, hardware: true, lighterCopy: true,
            next: { resolution: 'source', frameRate: 90 }, how: 'swap',
            capture: { width: 2560, height: 1440 }, step: 0, layout: 'whole',
            extra: { ask: '3840x2160', pub_res: '3840x2160', first_frame: '2560x1440', settle: 'pinned', settle_ms: 40 },
        });
        expect(ev.clamp).toMatchObject({ cap_res: '2560x1440', first_frame: '2560x1440', ask: '3840x2160', settle: 'pinned' });
        expect(validateCallEvent({ t: Date.now(), kind: 'share_clamp', detail: ev.clamp })).toEqual([]);
    });
});

// Linux Wayland window shares take their audio from ONE app (the handle the picker chose). Changing only
// the app is an audio change: not "the same live capture", and never a video change (the portal would
// open its chooser again for a re-acquire).
describe('the app a window share takes its audio from', () => {
    const WIN = { sourceId: 'window:7:0', audio: true } as const;
    const withApp = (h: string | null, over: Partial<ScreenShareOptions> = {}) =>
        opt({ ...WIN, ...(h ? { appAudio: { handle: h, name: 'x' } } : {}), ...over });

    it('another app is an audio-only change and not the same live capture', () => {
        expect(isAudioOnlyChange(withApp('aa_1'), withApp('aa_2'))).toBe(true);
        expect(sameLiveCapture(withApp('aa_1'), withApp('aa_2'))).toBe(false);
        expect(isAudioOnlyChange(withApp(null), withApp('aa_2'))).toBe(true);                // None -> an app
        expect(routeLiveSelection(true, withApp('aa_1'), withApp('aa_2'))).toBe('other');          // never a quality retune
    });

    it('the same app (or no app) is unchanged, and a quality change keeps its retune route', () => {
        expect(isAudioOnlyChange(withApp('aa_1'), withApp('aa_1'))).toBe(false);
        expect(sameLiveCapture(withApp('aa_1'), withApp('aa_1'))).toBe(true);
        expect(routeLiveSelection(true, withApp('aa_1'), withApp('aa_1', { resolution: '720p' }))).toBe('retune');
    });

    it('with audio off the app does not matter', () => {
        expect(isAudioOnlyChange(withApp('aa_1', { audio: false }), withApp('aa_2', { audio: false }))).toBe(false);
        expect(sameLiveCapture(withApp('aa_1', { audio: false }), withApp(null, { audio: false }))).toBe(true);
    });
});
