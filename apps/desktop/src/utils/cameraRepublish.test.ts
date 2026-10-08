import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Track, type TrackPublishOptions } from 'livekit-client';
import {
    republishCamera, relayerCamera, startCamera, watchHardwareCamera, getCameraPublishState,
    __resetCameraPublishForTests, REPUBLISH_HOLD_MS, type CameraParticipantLike,
} from './cameraPublish';
import { swapShareCodec } from './shareRepublish';
import { __resetHevcForTests, hasHevcFailed } from './hevcNegotiation';
import { getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';
import { afterEach } from 'vitest';

// Every event these flows log must pass the issue-reporter contract.
afterEach(() => { for (const e of getCallEvents()) expect({ kind: e.kind, problems: validateCallEvent(e) }).toEqual({ kind: e.kind, problems: [] }); });

/** A room-ish participant that, like LiveKit, can hold two publications of one source. */
function fakeRoom() {
    const pubs: { source: Track.Source; track: Record<string, unknown>; opts: TrackPublishOptions; isMuted?: boolean }[] = [];
    const order: string[] = [];
    const lp: CameraParticipantLike & { pubs: typeof pubs; order: string[] } = {
        pubs, order,
        getTrackPublication: (s: Track.Source) => pubs.find(p => p.source === s),
        setCameraEnabled: async () => {},
        createTracks: async () => [],
        publishTrack: async (t: never, opts: TrackPublishOptions) => {
            (t as Record<string, unknown>).publishOptions = opts;
            (t as Record<string, unknown>).codec = opts.videoCodec;
            pubs.push({ source: opts.source as Track.Source, track: t as Record<string, unknown>, opts });
            order.push(`publish:${opts.videoCodec}:${opts.simulcast ? 'sim' : 'single'}`);
            return {};
        },
        unpublishTrack: async (t: never) => {
            const i = pubs.findIndex(p => p.track === (t as unknown));
            if (i >= 0) pubs.splice(i, 1);
            order.push('unpublish');
            return {};
        },
    };
    return lp;
}

function liveCamera(opts: Partial<TrackPublishOptions> = {}) {
    const stopped: string[] = [];
    const mst = (name: string) => ({
        readyState: 'live', name,
        getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
        clone: () => mst(name + "'"),
        stop: () => { stopped.push(name); },
    }) as unknown as MediaStreamTrack;
    const track: Record<string, unknown> = {
        mediaStreamTrack: mst('cam'),
        constraints: { deviceId: { exact: 'cam-1' } },
        publishOptions: { source: Track.Source.Camera, simulcast: true, videoCodec: 'vp8', ...opts },
    };
    return { track, stopped };
}

const noSleep = async () => {};
const makeTrack = (mst: MediaStreamTrack, c: MediaTrackConstraints | undefined) => ({ mediaStreamTrack: mst, constraints: c });

beforeEach(() => { __resetCameraPublishForTests(); __resetHevcForTests(); clearCallEvents(); });

describe('republishCamera — make-before-break', () => {
    it('publishes the new one FIRST, holds, then unpublishes the old (viewers re-attach, never re-subscribe)', async () => {
        const lp = fakeRoom();
        const { track } = liveCamera();
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        const sleep = vi.fn(noSleep);
        expect(await republishCamera(lp, { single: true, sleep }, makeTrack, () => {})).toBe(true);
        expect(lp.order).toEqual(['publish:vp8:single', 'unpublish']);
        expect(sleep).toHaveBeenCalledWith(REPUBLISH_HOLD_MS);
        expect(lp.pubs).toHaveLength(1);
        const fresh = lp.pubs[0].track;
        expect(fresh).not.toBe(track);
        expect((fresh.mediaStreamTrack as { name: string }).name).toBe("cam'");          // a clone of the same capture
        expect(fresh.constraints).toEqual({ deviceId: { exact: 'cam-1' } });             // same device on later re-open
        expect(lp.pubs[0].opts.simulcast).toBe(false);
        expect(lp.pubs[0].opts.videoEncoding?.maxBitrate).toBe(3_500_000);
    });

    it('codec switch (H.265 negotiation): same layering, new codec, logged', async () => {
        const lp = fakeRoom();
        const { track } = liveCamera({ simulcast: false, videoCodec: 'h264' });
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        expect(await republishCamera(lp, { codec: 'h265', reason: 'everyone can decode H.265', sleep: noSleep }, makeTrack, () => {})).toBe(true);
        expect(lp.order).toEqual(['publish:h265:single', 'unpublish']);
        expect(lp.pubs[0].opts.videoEncoding?.maxBitrate).toBe(2_970_000);
        expect(getCallEvents().find(e => e.kind === 'h265_switch')?.detail).toEqual({ track: 'self-camera', codec: 'h265', reason: 'everyone can decode H.265' });
    });

    it('relayerCamera both ways', async () => {
        const lp = fakeRoom();
        const { track } = liveCamera({ simulcast: false });
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        vi.useFakeTimers();
        const p = relayerCamera(lp, false, makeTrack, () => {});
        await vi.advanceTimersByTimeAsync(REPUBLISH_HOLD_MS);
        expect(await p).toBe(true);
        vi.useRealTimers();
        expect(lp.pubs[0].opts.simulcast).toBe(true);
        expect(getCallEvents().find(e => e.kind === 'camera_layering')?.detail).toEqual({ mode: 'simulcast', layers: 3 });
    });

    it('no-ops: nothing to change, camera off/muted, picture processor attached, no camera', async () => {
        const lp = fakeRoom();
        expect(await republishCamera(lp, { single: true, sleep: noSleep }, makeTrack)).toBe(false);
        const { track } = liveCamera({ simulcast: false });
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        expect(await republishCamera(lp, { single: true, sleep: noSleep }, makeTrack)).toBe(false);
        lp.pubs[0].isMuted = true;
        expect(await republishCamera(lp, { single: false, sleep: noSleep }, makeTrack)).toBe(false);
        lp.pubs[0].isMuted = false;
        track.getProcessor = () => ({});
        expect(await republishCamera(lp, { single: false, sleep: noSleep }, makeTrack)).toBe(false);
        expect(lp.order).toEqual([]);
    });

    it('a failed publish keeps the old one and stops the clone', async () => {
        const lp = fakeRoom();
        const { track, stopped } = liveCamera();
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        lp.publishTrack = async () => { throw new Error('nope'); };
        expect(await republishCamera(lp, { single: true, sleep: noSleep }, makeTrack, () => {})).toBe(false);
        expect(lp.pubs[0].track).toBe(track);
        expect(stopped).toEqual(["cam'"]); // the clone, never the live capture
    });
});

describe('H.265 start check → make-before-break fallback', () => {
    it('H.265 that produced no frames: marks H.265 failed for the session and republishes on the base codec', async () => {
        const lp = fakeRoom();
        const { track } = liveCamera({ simulcast: false, videoCodec: 'h265' });
        track.sender = {
            getParameters: () => ({ encodings: [{ active: true }] }),
            getStats: async () => new Map([['a', { type: 'outbound-rtp', kind: 'video', framesEncoded: 0 }]]),
        };
        lp.pubs.push({ source: Track.Source.Camera, track, opts: track.publishOptions as TrackPublishOptions });
        const v = await watchHardwareCamera(lp, track as never, {
            tier: 'auto', log: () => {}, sleep: noSleep, makeTrack,
            codec: { pref: 'auto', probe: async () => ({ h264: true, vp8: false }), gpus: async () => [{ vendor: 'Intel' }] },
        });
        expect(v).toBe('no-frames');
        expect(hasHevcFailed()).toBe(true);
        expect(lp.order).toEqual(['publish:h264:single', 'unpublish']);
        expect(getCallEvents().map(e => e.kind)).toEqual(expect.arrayContaining(['camera_start_check', 'camera_fallback', 'h265_switch']));
    });

    it('startCamera with the room allowing H.265 publishes H.265 at the H.265 ladder', async () => {
        const lp = fakeRoom();
        const cam = { kind: 'video', mediaStreamTrack: { getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) }, stop() {}, restartTrack: async () => {} };
        lp.createTracks = async () => [cam];
        await startCamera(lp, { tier: '720p', hevc: true, watchHardware: false, log: () => {}, codec: { pref: 'auto', probe: async () => null, gpus: async () => null } });
        expect(lp.pubs[0].opts.videoCodec).toBe('h265');
        expect(lp.pubs[0].opts.videoEncoding?.maxBitrate).toBe(1_700_000);
        expect(getCameraPublishState()?.codec.reason).toBe('H.265 (everyone can decode)');
    });
});

describe('swapShareCodec — make-before-break for the screen share', () => {
    function liveShare(codec: string) {
        const mst = (name: string) => ({ readyState: 'live', name, contentHint: '', clone: () => mst(name + "'"), stop() {} }) as unknown as MediaStreamTrack;
        return { mediaStreamTrack: mst('screen'), codec } as Record<string, unknown>;
    }
    it('publishes the new codec first with motion content hint, holds, then unpublishes the old; no capture re-acquire', async () => {
        const lp = fakeRoom();
        const old = liveShare('h264');
        lp.pubs.push({ source: Track.Source.ScreenShare, track: old, opts: {} as TrackPublishOptions });
        const sleep = vi.fn(noSleep);
        const ok = await swapShareCodec(lp as never, 'vp8', { resolution: '1440p', frameRate: 90 }, {
            makeTrack: mst => ({ mediaStreamTrack: mst }), lowerLayer: false, reason: 'someone cannot decode H.265', sleep, log: () => {},
        });
        expect(ok).toBe(true);
        expect(lp.order).toEqual(['publish:vp8:single', 'unpublish']);
        expect(sleep).toHaveBeenCalledWith(REPUBLISH_HOLD_MS);
        const fresh = lp.pubs[0].track;
        expect((fresh.mediaStreamTrack as MediaStreamTrack).contentHint).toBe('motion');
        expect(lp.pubs[0].opts.screenShareEncoding?.maxFramerate).toBe(90);
    });
    it('same codec or an ended capture → nothing', async () => {
        const lp = fakeRoom();
        lp.pubs.push({ source: Track.Source.ScreenShare, track: liveShare('vp8'), opts: {} as TrackPublishOptions });
        expect(await swapShareCodec(lp as never, 'vp8', { resolution: '1080p', frameRate: 60 }, { makeTrack: m => ({ mediaStreamTrack: m }), lowerLayer: false, reason: 'x', sleep: noSleep })).toBe(false);
        expect(lp.order).toEqual([]);
    });
});
