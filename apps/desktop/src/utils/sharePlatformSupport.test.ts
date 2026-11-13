import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SHARE_HANDSHAKE_MS, PORTAL_HANDSHAKE_MS, captureHandshakeMs, shouldProbeNewSource, cancelStopsSwap,
    canReuseLiveCapture, windowAudioPicksApp, windowAudioBlockedReason, shouldAcquireBeforeTeardown, canReuseCropCapture, shareAudioUnavailableReason, windowAudioUnresolvedNotice, captureViaPortal, portalRestoreListed, resetCaptureViaPortalForTests,
    portalCaptureRequest, retuneTouchesCapture, readCaptureCeiling, PORTAL_FIRST_FRAME_WAIT, portalChooserClosedError,
    type ReuseCaptureInput, type AcquireFirstInput, type ReuseCropCaptureInput,
} from './sharePlatformSupport';
import { captureBoxFor } from './screenShare';
import { describeShareStartError } from './screenShareStartState';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

const opt = (o: Partial<ScreenShareOptions> = {}): ScreenShareOptions => ({
    sourceId: 'screen:0:0', resolution: '1080p', frameRate: 60, audio: false, ...o,
});

describe('capture handshake time', () => {
    it('is 10 s where only main has to answer (Windows, macOS, X11) - unchanged', () => {
        expect(SHARE_HANDSHAKE_MS).toBe(10_000);
        expect(captureHandshakeMs(false)).toBe(10_000);
    });
    it('is a person\'s time through the Wayland portal', () => {
        expect(captureHandshakeMs(true)).toBe(PORTAL_HANDSHAKE_MS);
        expect(PORTAL_HANDSHAKE_MS).toBeGreaterThanOrEqual(60_000);
    });
});

describe('the probe of a new source', () => {
    it('still runs everywhere except the portal (two dialogs for one change of source otherwise)', () => {
        expect(shouldProbeNewSource(false)).toBe(true);
        expect(shouldProbeNewSource(true)).toBe(false);
    });
});

describe('a closed portal dialog during a hot swap', () => {
    const notAllowed = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    it('ends the change through the portal', () => {
        expect(cancelStopsSwap(true, notAllowed)).toBe(true);
    });
    it('is not special anywhere else: the old fall-back-to-republish route stays', () => {
        expect(cancelStopsSwap(false, notAllowed)).toBe(false);
    });
    it('only NotAllowedError is a cancel; a source that failed to open is still a failure', () => {
        for (const name of ['NotReadableError', 'AbortError', 'NotFoundError', 'Error']) {
            expect(cancelStopsSwap(true, Object.assign(new Error('x'), { name }))).toBe(false);
        }
        expect(cancelStopsSwap(true, null)).toBe(false);
        expect(cancelStopsSwap(true, 'NotAllowedError')).toBe(false);
    });
});

describe('re-using the live capture for a fresh republish', () => {
    const base: ReuseCaptureInput = {
        viaPortal: true, fresh: true, live: true, cur: opt(), next: opt({ resolution: '720p' }),
        trackLive: true, ownPipeline: false,
    };
    it('happens through the portal for the same source, with no audio', () => {
        expect(canReuseLiveCapture(base)).toBe(true);
    });
    it('NEVER happens off the portal: Windows, macOS and X11 capture again exactly as before', () => {
        expect(canReuseLiveCapture({ ...base, viaPortal: false })).toBe(false);
    });
    it('needs a fresh publication of a live share whose capture is still running', () => {
        expect(canReuseLiveCapture({ ...base, fresh: false })).toBe(false);
        expect(canReuseLiveCapture({ ...base, live: false })).toBe(false);
        expect(canReuseLiveCapture({ ...base, cur: null })).toBe(false);
        expect(canReuseLiveCapture({ ...base, trackLive: false })).toBe(false);
    });
    it('is never a different source: a new source is a new capture, and a new consent', () => {
        expect(canReuseLiveCapture({ ...base, next: opt({ sourceId: 'screen:1:0' }) })).toBe(false);
        expect(canReuseLiveCapture({ ...base, next: opt({ sourceId: 'window:42:0' }) })).toBe(false);
    });
    it('does not care about audio: through the portal (Linux) the audio is the native PipeWire capture, not part of the capture request', () => {
        // (it used to refuse: audio on a reused capture is exactly what the earlier rule left to a new capture, i.e. a
        // second desktop chooser for turning audio on. The consent the audio rides on is renewed in main instead -
        // capture-consent.continueLive; see the wiring test below and capture-consent.test.ts.)
        expect(canReuseLiveCapture({ ...base, next: opt({ audio: true }) })).toBe(true);
        expect(canReuseLiveCapture({ ...base, cur: opt({ audio: true }) })).toBe(true);
        expect(canReuseLiveCapture({ ...base, cur: opt({ audio: true, appAudio: { handle: 'a', name: 'A' } }), next: opt({ audio: true, appAudio: { handle: 'b', name: 'B' } }) })).toBe(true);
    });
    it('is never a crop or HDR share (their track is generated, not captured) or a layout change', () => {
        expect(canReuseLiveCapture({ ...base, ownPipeline: true })).toBe(false);
        const slice = { kind: 'slice', count: 3, index: 1 } as const;
        expect(canReuseLiveCapture({ ...base, cur: opt({ layout: slice }), next: opt({ layout: slice }) })).toBe(false);
        expect(canReuseLiveCapture({ ...base, next: opt({ layout: slice }) })).toBe(false);
    });
});

describe('a change of source asks the portal BEFORE the running share is touched', () => {
    const base: AcquireFirstInput = { viaPortal: true, live: true, cur: opt(), next: opt({ sourceId: 'window:42:0' }) };
    it('happens through the portal for a different source of a live share', () => {
        expect(shouldAcquireBeforeTeardown(base)).toBe(true);
        expect(shouldAcquireBeforeTeardown({ ...base, next: opt({ sourceId: 'screen:1:0', resolution: '1440p' }) })).toBe(true);
    });
    it('NEVER happens while the live share is the native hardware one: it restarts natively instead of dropping to a Chromium capture (reports af77b854/eb4a0d66)', () => {
        expect(shouldAcquireBeforeTeardown({ ...base, nativeLive: true })).toBe(false);
        expect(shouldAcquireBeforeTeardown({ ...base, nativeLive: false })).toBe(true);   // control: the same input without a native share still acquires first
    });
    it('NEVER happens off the portal: Windows, macOS and X11 capture inside the republish exactly as before', () => {
        expect(shouldAcquireBeforeTeardown({ ...base, viaPortal: false })).toBe(false);
    });
    it('is for a change of source only: the same source (stall, codec drift, quality) has its own live capture', () => {
        expect(shouldAcquireBeforeTeardown({ ...base, next: opt({ resolution: '720p' }) })).toBe(false);
        expect(shouldAcquireBeforeTeardown({ ...base, next: opt() })).toBe(false);
    });
    it('is not a start from nothing: with no share running there is nothing to keep undisturbed', () => {
        expect(shouldAcquireBeforeTeardown({ ...base, live: false })).toBe(false);
        expect(shouldAcquireBeforeTeardown({ ...base, cur: null })).toBe(false);
    });
});

describe('slice to whole display keeps the crop pipeline\'s own capture', () => {
    const slice = { kind: 'slice', count: 3, index: 1 } as const;
    const base: ReuseCropCaptureInput = {
        viaPortal: true, live: true, cur: opt({ layout: slice }), next: opt(), cropPipeline: true, hdrPipeline: false,
    };
    it('happens through the portal for the same source going from one screen to the whole display', () => {
        expect(canReuseCropCapture(base)).toBe(true);
        expect(canReuseCropCapture({ ...base, next: opt({ layout: { kind: 'whole' } }) })).toBe(true);
    });
    it('NEVER happens off the portal', () => {
        expect(canReuseCropCapture({ ...base, viaPortal: false })).toBe(false);
    });
    it('needs a live share drawn through the crop pipeline, not the HDR one', () => {
        expect(canReuseCropCapture({ ...base, live: false })).toBe(false);
        expect(canReuseCropCapture({ ...base, cur: null })).toBe(false);
        expect(canReuseCropCapture({ ...base, cropPipeline: false })).toBe(false);
        expect(canReuseCropCapture({ ...base, hdrPipeline: true })).toBe(false);
    });
    it('is only slice -> whole of the SAME source, never to another screen or another source', () => {
        expect(canReuseCropCapture({ ...base, cur: opt() })).toBe(false);
        expect(canReuseCropCapture({ ...base, next: opt({ layout: slice }) })).toBe(false);
        expect(canReuseCropCapture({ ...base, next: opt({ sourceId: 'screen:1:0' }) })).toBe(false);
    });
    it('does not care about audio (it is not part of the capture on the portal)', () => {
        expect(canReuseCropCapture({ ...base, next: opt({ audio: true }) })).toBe(true);
        expect(canReuseCropCapture({ ...base, cur: opt({ layout: slice, audio: true }) })).toBe(true);
    });
});

describe('system audio on this platform', () => {
    it('is available on Linux exactly when the native PipeWire addon says it is supported', () => {
        expect(shareAudioUnavailableReason('linux', true)).toBeNull();
    });
    it('is unavailable on Linux without PipeWire, and says why (true, not "not yet")', () => {
        const why = shareAudioUnavailableReason('linux', false);
        expect(why).toMatch(/PipeWire/);
        expect(why).not.toMatch(/yet/);
        // Not knowing is not supporting: the default is the refusal.
        expect(shareAudioUnavailableReason('linux')).toBe(why);
    });
    it('is untouched on Windows, macOS and when the platform is unknown, whatever the addon says', () => {
        for (const supported of [true, false]) {
            expect(shareAudioUnavailableReason('windows', supported)).toBeNull();
            expect(shareAudioUnavailableReason('mac', supported)).toBeNull();
            expect(shareAudioUnavailableReason(undefined, supported)).toBeNull();
        }
        expect(shareAudioUnavailableReason('windows')).toBeNull();
    });
});

describe('a window whose process cannot be found', () => {
    it('on Linux explains that the desktop does not say, and points at picking the app or sharing the whole screen', () => {
        const t = windowAudioUnresolvedNotice('linux');
        expect(t).toMatch(/whole screen/);
        expect(t).toMatch(/Change source/);
        expect(t).toMatch(/without audio/i);
    });
    it('elsewhere keeps the original wording', () => {
        expect(windowAudioUnresolvedNotice('windows')).toBe('Could not identify the window\'s process for audio capture. Sharing without audio.');
        expect(windowAudioUnresolvedNotice('mac')).toBe(windowAudioUnresolvedNotice(undefined));
    });
});

describe('captureViaPortal', () => {
    beforeEach(() => resetCaptureViaPortalForTests());
    it('asks main once on Linux and caches the answer', async () => {
        const getShareCapturePath = vi.fn(async () => ({ viaPortal: true }));
        const api = { platform: 'linux', getShareCapturePath };
        expect(await captureViaPortal(api)).toBe(true);
        expect(await captureViaPortal(api)).toBe(true);
        expect(getShareCapturePath).toHaveBeenCalledTimes(1);
    });
    it('is false on X11 (main says so)', async () => {
        expect(await captureViaPortal({ platform: 'linux', getShareCapturePath: async () => ({ viaPortal: false }) })).toBe(false);
    });
    it('is false without asking on Windows and macOS', async () => {
        for (const platform of ['windows', 'mac']) {
            resetCaptureViaPortalForTests();
            const getShareCapturePath = vi.fn(async () => ({ viaPortal: true }));
            expect(await captureViaPortal({ platform, getShareCapturePath })).toBe(false);
            expect(getShareCapturePath).not.toHaveBeenCalled();
        }
    });
    it('is false when main cannot say (an older main, or the call fails)', async () => {
        expect(await captureViaPortal({ platform: 'linux' })).toBe(false);
        resetCaptureViaPortalForTests();
        expect(await captureViaPortal({ platform: 'linux', getShareCapturePath: async () => { throw new Error('gone'); } })).toBe(false);
        resetCaptureViaPortalForTests();
        expect(await captureViaPortal(undefined)).toBe(false);
    });
});

describe('portalRestoreListed', () => {
    beforeEach(() => resetCaptureViaPortalForTests());
    it('is what main says, through the same one cached probe as captureViaPortal', async () => {
        const getShareCapturePath = vi.fn(async () => ({ viaPortal: true, restoreListed: true }));
        const api = { platform: 'linux', getShareCapturePath };
        expect(await portalRestoreListed(api)).toBe(true);
        expect(await captureViaPortal(api)).toBe(true);
        expect(getShareCapturePath).toHaveBeenCalledTimes(1);
    });
    it('is false unless main says true: an older main, X11, a failed call, other platforms', async () => {
        expect(await portalRestoreListed({ platform: 'linux', getShareCapturePath: async () => ({ viaPortal: true }) })).toBe(false);
        resetCaptureViaPortalForTests();
        expect(await portalRestoreListed({ platform: 'linux', getShareCapturePath: async () => ({ viaPortal: false, restoreListed: true }) })).toBe(false);
        resetCaptureViaPortalForTests();
        expect(await portalRestoreListed({ platform: 'linux', getShareCapturePath: async () => { throw new Error('gone'); } })).toBe(false);
        resetCaptureViaPortalForTests();
        const getShareCapturePath = vi.fn(async () => ({ viaPortal: true, restoreListed: true }));
        expect(await portalRestoreListed({ platform: 'windows', getShareCapturePath })).toBe(false);
        expect(getShareCapturePath).not.toHaveBeenCalled();
        expect(await portalRestoreListed(undefined)).toBe(false);
    });
});

describe('which Linux picks get the "Share audio from: [app]" chooser', () => {
    it('only a window through the portal (or while that is not known yet)', () => {
        expect(windowAudioPicksApp('linux', true, true)).toBe(true);
        expect(windowAudioPicksApp('linux', null, true)).toBe(true);
    });
    it('not an X11 window (automatic pid), not a screen (everything but Cipherline), not other platforms', () => {
        expect(windowAudioPicksApp('linux', false, true)).toBe(false);
        expect(windowAudioPicksApp('linux', true, false)).toBe(false);
        expect(windowAudioPicksApp('windows', true, true)).toBe(false);
        expect(windowAudioPicksApp('mac', null, true)).toBe(false);
        expect(windowAudioPicksApp(undefined, true, true)).toBe(false);
    });
    it('the greyed-out reason now only shows where the app list cannot be had', () => {
        expect(windowAudioBlockedReason('linux', true, true)).toMatch(/whole screen/);          // main cannot list apps
        expect(windowAudioBlockedReason('linux', true, true, true)).toBeNull();                 // it can: the chooser replaces the box
        expect(windowAudioBlockedReason('linux', false, true, false)).toBeNull();
    });
});

describe('what a portal capture is asked for: the SOURCE\'s size at the rate the person picked', () => {
    it('the box is the source\'s own (the codec-clamped 8K box) whatever resolution was picked: the picked size is the encoder\'s', () => {
        for (const res of ['480p', '720p', '1080p', '1440p', 'source'] as const) {
            expect(portalCaptureRequest({ resolution: res, frameRate: 30 }, 60).box).toEqual(captureBoxFor('source', 'h264'));
        }
        // clamped by the codec table (4K UHD for h264): never the 8K a Surround display black-screened on
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 30 }, null).box).toEqual({ width: 3840, height: 2160 });
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 60 }, 60, 'vp9').box).toEqual(captureBoxFor('source', 'vp9'));
    });
    it('negative control (the old behaviour): a capture opened AT the picked box is a downscaled capture - reports 87a453ae / 6a325d4e', () => {
        // 1080p@90 of a 3440x1440 screen was captured at 1920x804 and delivered 19-44 fps; the source-size capture 59-75.
        const picked = captureBoxFor('1080p', 'vp8');
        expect(picked).toEqual({ width: 1920, height: 1080 });
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 90 }, null, 'vp8').box).not.toEqual(picked);
    });
    it('a picked 30 fps (or less) is captured at exactly 30: not 1.25x, and never the 75-113 fps maximum', () => {
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 30 }, 60).frameRate).toBe(30);
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 15 }, null).frameRate).toBe(15);
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 30 }, null).frameRate).toBe(30);
    });
    it('above 30 the paced rate (1.25x, held to the capturer\'s ceiling) is kept: 60 -> 75 under a 60 ceiling, 90 -> 113 with none', () => {
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 60 }, 60).frameRate).toBe(75);
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 90 }, 60).frameRate).toBe(75);
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 90 }, null).frameRate).toBe(113);
        expect(portalCaptureRequest({ resolution: '1080p', frameRate: 60 }, null).frameRate).toBe(75);
    });
    it('control: a higher pick asks for a higher rate, so the rate really depends on the pick', () => {
        const lo = portalCaptureRequest({ resolution: '720p', frameRate: 30 }, 60);
        const hi = portalCaptureRequest({ resolution: '1440p', frameRate: 60 }, 60);
        expect(hi.frameRate).toBeGreaterThan(lo.frameRate);
    });
});

describe('does a live quality change reach the capture?', () => {
    it('off the portal it does (Windows, macOS, X11: applyConstraints, as ever)', () => {
        expect(retuneTouchesCapture(false)).toBe(true);
    });
    it('through the portal the portal-free answer is no: portalCapturePlan decides (it needs what the capture was asked for)', () => {
        expect(retuneTouchesCapture(true)).toBe(false);
    });
});

describe('readCaptureCeiling', () => {
    it('is the highest ceiling any display reports; none / unknown / a failure is null', async () => {
        expect(await readCaptureCeiling({ getDisplayRefreshRates: async () => [{ captureFpsCeiling: 60 }, { captureFpsCeiling: null }] })).toBe(60);
        expect(await readCaptureCeiling({ getDisplayRefreshRates: async () => [{ captureFpsCeiling: null }] })).toBeNull();
        expect(await readCaptureCeiling({ getDisplayRefreshRates: async () => [] })).toBeNull();
        expect(await readCaptureCeiling({ getDisplayRefreshRates: async () => { throw new Error('gone'); } })).toBeNull();
        expect(await readCaptureCeiling({})).toBeNull();
        expect(await readCaptureCeiling(undefined)).toBeNull();
    });
});

describe('a portal capture is "here" only at its first frame (getDisplayMedia resolves before the desktop has been asked)', () => {
    it('waits for as long as a person may take, not the 1.5 s of a local first-frame probe', () => {
        expect(PORTAL_FIRST_FRAME_WAIT.timeoutMs).toBe(PORTAL_HANDSHAKE_MS);
        expect(PORTAL_FIRST_FRAME_WAIT.timeoutMs).toBeGreaterThanOrEqual(60_000);
    });
    it('a chooser that ended without a choice is a CANCEL: quietly on Linux, and it ends a hot swap without tearing the running share down', () => {
        const err = portalChooserClosedError();
        expect(err.name).toBe('NotAllowedError');
        expect(describeShareStartError(err, 'linux')).toEqual({ kind: 'cancelled' });
        expect(cancelStopsSwap(true, err)).toBe(true);
    });
});
