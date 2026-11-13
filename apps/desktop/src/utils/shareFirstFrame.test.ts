import { describe, it, expect, vi, afterEach } from 'vitest';
import { Track } from 'livekit-client';
import {
    waitForFirstFrameSize, pinTrackSettingsSize, settleCaptureSize, settleEventDetails,
    publishScreenShareSettled, fmtSize, FIRST_FRAME_TIMEOUT_MS,
    type FrameProbeElement, type SettledPublishParticipant,
} from './shareFirstFrame';
import { validateCallEvent } from './callEventLog';
import { planEncode } from './shareEncoderLimits';
import { shareLowEncoding } from './screenShare';

afterEach(() => { vi.useRealTimers(); });

// Owner's PC (2026-10-31): a 2560x1440 display, 'source' -> the 3840x2160 capture BOX.
const BOX = { width: 3840, height: 2160 };
const REAL = { width: 2560, height: 1440 };

/** A capture track that reports the constraint box until `arrive()`, then the real frame size. */
function fakeCapture() {
    let frame: { width: number; height: number } | null = null;
    const track = {
        readyState: 'live' as 'live' | 'ended',
        getSettings: (): { width: number; height: number; frameRate?: number } => ({ ...(frame ?? BOX), frameRate: 113 }),
    };
    return { track: track as unknown as MediaStreamTrack, raw: track, arrive: () => { frame = REAL; }, hasFrame: () => frame !== null };
}

/** A probe element whose videoWidth/Height become the capture's real size once its first frame lands. */
function fakeElement(cap: ReturnType<typeof fakeCapture>, opts: { neverDecodes?: boolean } = {}) {
    const listeners = new Map<string, () => void>();
    const el: FrameProbeElement & { played: boolean; paused: boolean } = {
        srcObject: null, muted: false, played: false, paused: false,
        get videoWidth() { return cap.hasFrame() && !opts.neverDecodes ? REAL.width : 0; },
        get videoHeight() { return cap.hasFrame() && !opts.neverDecodes ? REAL.height : 0; },
        play() { el.played = true; },
        pause() { el.paused = true; },
        addEventListener: (t, fn) => { listeners.set(t, fn); },
        removeEventListener: t => { listeners.delete(t); },
    };
    return { el, listeners };
}

describe('waitForFirstFrameSize', () => {
    it('resolves with the first real frame size, ignoring what the track reports meanwhile', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap);
        const p = waitForFirstFrameSize(cap.track, { createElement: () => el, makeStream: t => ({ t }) });
        await vi.advanceTimersByTimeAsync(100);
        cap.arrive();
        await vi.advanceTimersByTimeAsync(60);
        const r = await p;
        expect(r.how).toBe('frame');
        expect(r.size).toEqual(REAL);
        // the probe only read: muted, played, and let go of the stream again
        expect(el.muted).toBe(true);
        expect(el.played).toBe(true);
        expect(el.srcObject).toBeNull();
        expect(cap.raw.readyState).toBe('live');
    });

    it('is bounded: no frame by the timeout means size null, never a hang (the share carries on as before)', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap, { neverDecodes: true });
        const p = waitForFirstFrameSize(cap.track, { createElement: () => el, makeStream: () => ({}) });
        await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS + 10);
        const r = await p;
        expect(r).toMatchObject({ size: null, how: 'timeout' });
        expect(el.srcObject).toBeNull();
        expect(FIRST_FRAME_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    });

    it('a track that ends while waiting resolves at once with no size', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap, { neverDecodes: true });
        const p = waitForFirstFrameSize(cap.track, { createElement: () => el, makeStream: () => ({}) });
        cap.raw.readyState = 'ended';
        await vi.advanceTimersByTimeAsync(30);
        expect(await p).toMatchObject({ size: null, how: 'ended' });
    });

    it('no DOM to probe with (or an element that throws) is "unsupported", not an error', async () => {
        const cap = fakeCapture();
        expect(await waitForFirstFrameSize(cap.track, { createElement: () => { throw new Error('no document'); } }))
            .toMatchObject({ size: null, how: 'unsupported' });
        // node test environment: no `document` unless the setup stubs one in
        const r = await waitForFirstFrameSize(cap.track, { timeoutMs: 20, makeStream: () => ({}) });
        expect(r.size).toBeNull();
    });

    it('the loadedmetadata event is enough without waiting for the poll', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el, listeners } = fakeElement(cap);
        const p = waitForFirstFrameSize(cap.track, { createElement: () => el, makeStream: () => ({}) });
        cap.arrive();
        listeners.get('loadedmetadata')?.();
        expect(await p).toMatchObject({ size: REAL, how: 'frame' });
    });
});

describe('pinTrackSettingsSize', () => {
    it('getSettings reports the pinned size (other members kept) until released, then the original again', () => {
        const cap = fakeCapture();
        expect(cap.track.getSettings()).toMatchObject(BOX);
        const release = pinTrackSettingsSize(cap.track, REAL);
        expect(cap.track.getSettings()).toMatchObject({ ...REAL, frameRate: 113 });
        release();
        expect(cap.track.getSettings()).toMatchObject(BOX);
    });
});

describe('pinTrackSettingsSize on a track shaped like the real one (getSettings on the PROTOTYPE)', () => {
    class RealShapedTrack {
        getSettings() { return { width: 3840, height: 2160 }; }
    }
    it('release removes the own property so the prototype method is back, untouched', () => {
        const t = new RealShapedTrack();
        const release = pinTrackSettingsSize(t as unknown as MediaStreamTrack, REAL);
        expect(Object.prototype.hasOwnProperty.call(t, 'getSettings')).toBe(true);
        expect(t.getSettings()).toMatchObject(REAL);
        release();
        expect(Object.prototype.hasOwnProperty.call(t, 'getSettings')).toBe(false);
        expect(t.getSettings()).toMatchObject(BOX);
        expect(new RealShapedTrack().getSettings()).toMatchObject(BOX); // other tracks never changed
    });
});

describe('settleCaptureSize', () => {
    it('track says the box, first frame says 2560x1440: the track is pinned to the frame, then released', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap);
        const p = settleCaptureSize(cap.track, BOX, { createElement: () => el, makeStream: () => ({}) });
        cap.arrive();
        // frames arrive, and (the race) the track STILL reports the box
        cap.raw.getSettings = () => ({ ...BOX, frameRate: 113 });
        await vi.advanceTimersByTimeAsync(50);
        const s = await p;
        expect(s).toMatchObject({ asked: BOX, initial: BOX, first: REAL, how: 'frame', pinned: true });
        expect(s.reported).toEqual(REAL);
        expect(cap.track.getSettings()).toMatchObject(REAL);
        s.release();
        s.release(); // idempotent
        expect(cap.track.getSettings()).toMatchObject(BOX);
    });

    it('the track already tells the truth: nothing is pinned', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        cap.arrive();
        const { el } = fakeElement(cap);
        const p = settleCaptureSize(cap.track, BOX, { createElement: () => el, makeStream: () => ({}) });
        await vi.advanceTimersByTimeAsync(10);
        const s = await p;
        expect(s).toMatchObject({ first: REAL, pinned: false, how: 'frame' });
        expect(Object.prototype.hasOwnProperty.call(cap.raw, 'getSettings')).toBe(true); // our own fake's, untouched
        expect(cap.track.getSettings()).toMatchObject(REAL);
    });

    it('timeout: nothing is pinned, today\'s behaviour', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap, { neverDecodes: true });
        const p = settleCaptureSize(cap.track, BOX, { timeoutMs: 200, createElement: () => el, makeStream: () => ({}) });
        await vi.advanceTimersByTimeAsync(250);
        const s = await p;
        expect(s).toMatchObject({ first: null, pinned: false, how: 'timeout' });
        expect(cap.track.getSettings()).toMatchObject(BOX);
    });
});

describe('the false size reaches the encoder settings; the real one does not', () => {
    // What cap_res=3840x2160 does downstream (the numbers behind the module's header):
    it('lighter copy scale from the false size is 3 (853x480), from the real size 2 (1280x720)', () => {
        const falseLow = shareLowEncoding(BOX.width, BOX.height, 60, 'h265');
        const realLow = shareLowEncoding(REAL.width, REAL.height, 60, 'h265');
        expect(falseLow.scaleResolutionDownBy).toBe(3);
        expect(Math.floor(REAL.width / falseLow.scaleResolutionDownBy)).toBe(853); // odd width
        expect(realLow.scaleResolutionDownBy).toBe(2);
        expect(REAL.width / realLow.scaleResolutionDownBy).toBe(1280);
    });
    it('planEncode reports the (non-)clamp of the false size as a 3840x2160 encode that never happens', () => {
        expect(planEncode('h265', BOX.width, BOX.height).width).toBe(3840);
        expect(planEncode('h265', REAL.width, REAL.height).width).toBe(2560);
    });
});

describe('settleEventDetails (the share_clamp fields)', () => {
    it('carries ask / pub_res / first_frame / settle and passes the call-event validator', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap);
        const p = settleCaptureSize(cap.track, BOX, { createElement: () => el, makeStream: () => ({}) });
        cap.arrive();
        cap.raw.getSettings = () => ({ ...BOX });
        await vi.advanceTimersByTimeAsync(50);
        const s = await p;
        const d = settleEventDetails(s);
        expect(d).toMatchObject({ ask: '3840x2160', pub_res: '3840x2160', first_frame: '2560x1440', settle: 'pinned' });
        expect(typeof d.settle_ms).toBe('number');
        expect(validateCallEvent({ t: Date.now(), kind: 'share_clamp', detail: { codec: 'h265', phase: 'pre', ...d } })).toEqual([]);
        s.release();
    });
    it('a timeout names itself and leaves first_frame empty', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap, { neverDecodes: true });
        const p = settleCaptureSize(cap.track, BOX, { timeoutMs: 50, createElement: () => el, makeStream: () => ({}) });
        await vi.advanceTimersByTimeAsync(80);
        const d = settleEventDetails(await p);
        expect(d).toMatchObject({ first_frame: '', settle: 'timeout' });
        expect(fmtSize(null)).toBe('');
    });
});

// ── The publish: LiveKit reads the track's size INSIDE publishTrack ──────────
function fakeParticipant(cap: ReturnType<typeof fakeCapture>, opts: { existingPub?: boolean; publishThrows?: boolean } = {}) {
    const seenAtPublish: Array<{ width?: number; height?: number }> = [];
    const stops: string[] = [];
    const video = { kind: Track.Kind.Video, mediaStreamTrack: cap.track, stop: () => stops.push('video') };
    const audio = { kind: Track.Kind.Audio, mediaStreamTrack: {} as MediaStreamTrack, stop: () => stops.push('audio') };
    const lp = {
        getTrackPublication: () => (opts.existingPub ? ({}) : undefined),
        createScreenTracks: vi.fn(async () => [video, audio]),
        // what livekit-client's publishTrack -> waitForDimensions does: read getSettings() once, now
        publishTrack: vi.fn(async (t: { kind: string; mediaStreamTrack: MediaStreamTrack }) => {
            if (t.kind === Track.Kind.Video) seenAtPublish.push(t.mediaStreamTrack.getSettings());
            if (opts.publishThrows) throw new Error('negotiation failed');
        }),
        setScreenShareEnabled: vi.fn(async () => { seenAtPublish.push(cap.track.getSettings()); }),
    };
    return { lp: lp as unknown as SettledPublishParticipant, raw: lp, seenAtPublish, stops };
}

describe('publishScreenShareSettled', () => {
    it('livekit sees the REAL frame size at publish, though the track still says the box', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap);
        const f = fakeParticipant(cap);
        const order: string[] = [];
        const p = publishScreenShareSettled(f.lp, { resolution: { ...BOX, frameRate: 113 }, audio: false, contentHint: 'motion' }, { videoCodec: 'h265' }, {
            onSettled: () => order.push('settled'),
            waitOptions: { createElement: () => el, makeStream: () => ({}) },
        });
        cap.arrive();
        cap.raw.getSettings = () => ({ ...BOX });  // the race: frames flow, getSettings lags
        await vi.advanceTimersByTimeAsync(60);
        const settled = await p;
        expect(f.seenAtPublish).toEqual([expect.objectContaining(REAL)]);
        expect(settled).toMatchObject({ first: REAL, pinned: true, asked: BOX });
        expect(order).toEqual(['settled']);
        // both tracks (video + loopback audio) published with the same options, then the pin is gone
        expect(f.raw.publishTrack).toHaveBeenCalledTimes(2);
        expect(f.raw.publishTrack).toHaveBeenCalledWith(expect.anything(), { videoCodec: 'h265' });
        expect(cap.track.getSettings()).toMatchObject(BOX);
        expect(f.raw.setScreenShareEnabled).not.toHaveBeenCalled();
    });

    it('negative control: the stock setScreenShareEnabled publishes the false box size (the behaviour before this change)', async () => {
        const cap = fakeCapture();
        const f = fakeParticipant(cap);
        await f.lp.setScreenShareEnabled(true, { resolution: { ...BOX, frameRate: 113 } }, {});
        expect(f.seenAtPublish).toEqual([expect.objectContaining(BOX)]);
    });

    it('a timeout still publishes (with whatever the track reports), the settle record says so', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap, { neverDecodes: true });
        const f = fakeParticipant(cap);
        const p = publishScreenShareSettled(f.lp, {}, {}, { waitOptions: { timeoutMs: 100, createElement: () => el, makeStream: () => ({}) } });
        await vi.advanceTimersByTimeAsync(150);
        const settled = await p;
        expect(settled).toMatchObject({ first: null, how: 'timeout' });
        expect(f.seenAtPublish).toEqual([expect.objectContaining(BOX)]);
        expect(f.raw.publishTrack).toHaveBeenCalledTimes(2);
    });

    it('a failed publish stops every captured track and un-pins', async () => {
        vi.useFakeTimers();
        const cap = fakeCapture();
        const { el } = fakeElement(cap);
        const f = fakeParticipant(cap, { publishThrows: true });
        const p = publishScreenShareSettled(f.lp, {}, {}, { waitOptions: { createElement: () => el, makeStream: () => ({}) } });
        const caught = p.catch(e => e);
        cap.arrive();
        cap.raw.getSettings = () => ({ ...BOX });
        await vi.advanceTimersByTimeAsync(60);
        expect(String(await caught)).toContain('negotiation failed');
        expect(f.stops.sort()).toEqual(['audio', 'video']);
        expect(cap.track.getSettings()).toMatchObject(BOX);
    });

    it('a failed capture throws before anything exists to clean up', async () => {
        const cap = fakeCapture();
        const f = fakeParticipant(cap);
        f.raw.createScreenTracks.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
        await expect(publishScreenShareSettled(f.lp, {}, {})).rejects.toMatchObject({ name: 'NotAllowedError' });
        expect(f.raw.publishTrack).not.toHaveBeenCalled();
    });

    it('an existing screen-share publication keeps the stock behaviour (nothing new is captured)', async () => {
        const cap = fakeCapture();
        const f = fakeParticipant(cap, { existingPub: true });
        expect(await publishScreenShareSettled(f.lp, { audio: false }, {})).toBeNull();
        expect(f.raw.setScreenShareEnabled).toHaveBeenCalledTimes(1);
        expect(f.raw.createScreenTracks).not.toHaveBeenCalled();
    });
});
