import { describe, it, expect, beforeEach } from 'vitest';
import { Track, type TrackPublishOptions, type VideoPreset } from 'livekit-client';
import {
    startCamera, settleCaptureMode, retuneCamera, applyCameraTier, watchHardwareCamera, restartOptions, recoverStalledCamera,
    toLiveKitPublishOptions, getCameraPublishState, hasHwCameraFailed, readCameraEncoderInfo,
    __resetCameraPublishForTests, type CameraTrackLike, type CameraParticipantLike, type StartCameraOptions,
} from './cameraPublish';
import { cameraPublishPlan, cameraLayerBitrate } from './cameraQuality';

/**
 * A fake camera: `modes` is what the device can deliver; a request picks the
 * largest mode not above the requested height (Chromium's "never upscale"),
 * at that mode's fps.
 */
function fakeCamera(modes: { width: number; height: number; frameRate: number }[], deviceId = 'cam-1') {
    let cur = modes[0];
    const restarts: unknown[] = [];
    const pick = (h: number) => {
        const fit = modes.filter(m => m.height <= h).sort((a, b) => b.height - a.height)[0];
        return fit ?? modes[modes.length - 1];
    };
    const track: CameraTrackLike & { kind: string; restarts: unknown[]; stopped: boolean; refreshed: number; setTo(h: number): void } = {
        kind: 'video',
        restarts,
        stopped: false,
        refreshed: 0,
        constraints: { deviceId: { exact: deviceId } },
        mediaStreamTrack: {
            getSettings: () => ({ ...cur }),
            getCapabilities: () => ({ height: { max: Math.max(...modes.map(m => m.height)) } }),
        } as unknown as MediaStreamTrack,
        async restartTrack(o) { restarts.push(o); cur = pick(o?.resolution?.height ?? 720); },
        stop() { track.stopped = true; },
        setTo(h: number) { cur = pick(h); },
    };
    (track as unknown as { onSenderTrackSwapped: () => Promise<void> }).onSenderTrackSwapped = async () => { track.refreshed++; };
    return track;
}

function fakeParticipant(camera: ReturnType<typeof fakeCamera>) {
    const published: { track: unknown; opts: TrackPublishOptions }[] = [];
    let pub: { track?: unknown } | undefined;
    const lp: CameraParticipantLike & { published: typeof published; enabledCalls: boolean[]; createCalls: unknown[]; unpublished: unknown[] } = {
        published,
        enabledCalls: [],
        createCalls: [],
        unpublished: [],
        getTrackPublication: (s: Track.Source) => (s === Track.Source.Camera ? pub : undefined),
        setCameraEnabled: async (on: boolean) => { lp.enabledCalls.push(on); },
        createTracks: async (o: { video: { resolution: { width: number; height: number; frameRate: number } } }) => {
            lp.createCalls.push(o);
            camera.setTo(o.video.resolution.height);
            return [camera];
        },
        publishTrack: async (t: never, opts: TrackPublishOptions) => {
            published.push({ track: t, opts });
            (camera as CameraTrackLike).publishOptions = opts;
            pub = { track: t };
            return pub;
        },
        unpublishTrack: async (t: never) => { lp.unpublished.push(t); pub = undefined; },
    };
    return lp;
}

const vp8Only: StartCameraOptions['codec'] = { pref: 'auto', probe: async () => ({ h264: false, h264High: false, vp8: false }), gpus: async () => [{ vendor: 'Intel' }] };
const hwH264: StartCameraOptions['codec'] = { pref: 'auto', probe: async () => ({ h264: true, h264High: true, vp8: false }), gpus: async () => [{ vendor: 'Intel' }] };
const quiet = () => {};

const layerSizes = (o: TrackPublishOptions) => (o.videoSimulcastLayers ?? []).map((p: VideoPreset) => `${p.width}x${p.height}`);

beforeEach(() => __resetCameraPublishForTests());

describe('startCamera — capture at the camera\'s best native mode, ladder from what it delivers', () => {
    it('Auto on a 720p-only camera publishes a 720p top layer (never upscaled)', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }, { width: 640, height: 360, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        // Asked for 1080p (Auto in software), the camera's best is 720p: 720p it is.
        expect(lp.createCalls).toEqual([{ video: { resolution: { width: 1920, height: 1080, frameRate: 30 } } }]);
        const o = lp.published[0].opts;
        expect(o.source).toBe(Track.Source.Camera);
        expect(o.videoEncoding).toEqual({ maxBitrate: 2_000_000, maxFramerate: 30 });
        expect(layerSizes(o)).toEqual(['320x180', '640x360']);
        expect(o.videoCodec).toBe('vp8');
        expect(o.simulcast).toBe(true);
        expect(o.backupCodec).toBe(false);
        expect(o.degradationPreference).toBe('balanced');
        expect(getCameraPublishState()?.capture).toEqual({ width: 1280, height: 720, frameRate: 30 });
    });

    it('a 1440p camera on Auto WITH a hardware encoder gets the 360 / 720 / 1440 ladder', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1920, height: 1080, frameRate: 30 }, { width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        const o = lp.published[0].opts;
        expect(lp.createCalls).toEqual([{ video: { resolution: { width: 2560, height: 1440, frameRate: 30 } } }]);
        expect(o.videoCodec).toBe('h264');
        expect(o.videoEncoding?.maxBitrate).toBe(cameraLayerBitrate(2560, 1440, 'h264'));
        expect(layerSizes(o)).toEqual(['640x360', '1280x720']);
    });

    it('Auto WITHOUT a hardware encoder caps at 1080p (software 1440p VP8 ≈ 4.7 cores)', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        expect(lp.createCalls).toEqual([{ video: { resolution: { width: 1920, height: 1080, frameRate: 30 } } }]);
        expect(lp.published[0].opts.videoEncoding?.maxBitrate).toBe(3_500_000);
        expect(getCameraPublishState()?.tier).toBe('auto');
    });

    it('an explicit 1440p choice is honoured even in software', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: '1440p', codec: vp8Only, log: quiet });
        expect(lp.published[0].opts.videoEncoding?.maxBitrate).toBe(5_500_000);
    });

    it('the VP8 fallback after a failed HW start re-captures at the software cap', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        cam.sender = {
            getParameters: () => ({ encodings: [{ rid: 'f', active: true }] }),
            getStats: async () => new Map([['f', { type: 'outbound-rtp', kind: 'video', rid: 'f', framesEncoded: 0 }]]),
        } as unknown as RTCRtpSender;
        await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: async () => {} });
        expect(lp.createCalls[1]).toEqual({ video: { resolution: { width: 1920, height: 1080, frameRate: 30 } } });
        expect(lp.published[1].opts.videoEncoding?.maxBitrate).toBe(3_500_000);
    });

    it('the 1080p tier caps a 1440p camera at 1080p', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: '1080p', codec: vp8Only, log: quiet });
        expect(lp.published[0].opts.videoEncoding?.maxBitrate).toBe(3_500_000);
        expect(layerSizes(lp.published[0].opts)).toEqual(['480x270', '960x540']);
    });

    it('a camera whose 1080p mode is slow (USB2 YUY2 1080p@5) is stepped down to 720p30 before publishing', async () => {
        const cam = fakeCamera([{ width: 1920, height: 1080, frameRate: 5 }, { width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        expect(cam.restarts).toEqual([{ resolution: { width: 1280, height: 720, frameRate: 30 }, deviceId: { exact: 'cam-1' } }]);
        expect(lp.published[0].opts.videoEncoding?.maxBitrate).toBe(2_000_000);
    });

    it('a later toggle is LiveKit\'s own unmute of the existing publication', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        expect(lp.published).toHaveLength(1);
        expect(lp.enabledCalls).toEqual([true]);
    });

    it('a double click publishes once', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await Promise.all([
            startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet }),
            startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet }),
        ]);
        expect(lp.published).toHaveLength(1);
        expect(lp.createCalls).toHaveLength(1);
    });

    it('a failed publish stops the captured track and rethrows', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        lp.publishTrack = async () => { throw new Error('denied'); };
        await expect(startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet })).rejects.toThrow('denied');
        expect(cam.stopped).toBe(true);
    });

    it('hardware H.264 when the GPU has it; the High intent is set BEFORE publishTrack', async () => {
        const cam = fakeCamera([{ width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        const order: string[] = [];
        const orig = lp.publishTrack;
        lp.publishTrack = async (t, o) => { order.push('publish'); return orig(t, o); };
        await startCamera(lp, {
            tier: 'auto', log: quiet, watchHardware: false,
            codec: { pref: 'auto', probe: async () => ({ h264: false, h264High: true, vp8: false }), gpus: async () => [{ vendor: 'NVIDIA' }] },
            setWantH264High: on => order.push(`high=${on}`),
        });
        expect(order).toEqual(['high=true', 'publish']);
        expect(lp.published[0].opts.videoCodec).toBe('h264');
        expect(lp.published[0].opts.videoEncoding?.maxBitrate).toBe(4_020_000); // 3.5 Mbps × 1.15, to 10 kbps
    });

    it('a probe that throws falls back to VP8 (never blocks the camera)', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', log: quiet, codec: { pref: 'auto', probe: async () => { throw new Error('x'); }, gpus: async () => null } });
        expect(lp.published[0].opts.videoCodec).toBe('vp8');
    });
});

describe('watchHardwareCamera — the H.264 start check and the VP8 fallback', () => {
    function withSender(cam: ReturnType<typeof fakeCamera>, layers: { rid: string; active: boolean; framesEncoded: number; impl: string }[]) {
        cam.sender = {
            getParameters: () => ({ encodings: layers.map(l => ({ rid: l.rid, active: l.active })) }),
            getStats: async () => {
                const m = new Map<string, unknown>();
                layers.forEach(l => m.set(l.rid, { type: 'outbound-rtp', kind: 'video', rid: l.rid, framesEncoded: l.framesEncoded, encoderImplementation: l.impl }));
                return m;
            },
        } as unknown as RTCRtpSender;
    }
    const noSleep = async () => {};

    it('ok: hardware encoding on every live layer → keeps H.264', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        withSender(cam, [
            { rid: 'q', active: true, framesEncoded: 180, impl: 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator)' },
            { rid: 'h', active: true, framesEncoded: 180, impl: 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator)' },
            { rid: 'f', active: true, framesEncoded: 180, impl: 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator)' },
        ]);
        const v = await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: noSleep });
        expect(v).toBe('ok');
        expect(lp.unpublished).toHaveLength(0);
        expect(hasHwCameraFailed()).toBe(false);
    });

    it('no-frames on a live layer → unpublish, republish as VP8 (same E2EE room), remember for the session', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        withSender(cam, [
            { rid: 'q', active: true, framesEncoded: 180, impl: 'ExternalEncoder' },
            { rid: 'f', active: true, framesEncoded: 0, impl: 'ExternalEncoder' },
        ]);
        const v = await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: noSleep });
        expect(v).toBe('no-frames');
        expect(lp.unpublished).toEqual([cam]);
        expect(lp.published).toHaveLength(2);
        expect(lp.published[1].opts.videoCodec).toBe('vp8');
        expect(hasHwCameraFailed()).toBe(true);
        expect(getCameraPublishState()?.codec.reason).toMatch(/no frames/);
    });

    it('software H.264 (OpenH264) → VP8 too', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        withSender(cam, [{ rid: 'q', active: true, framesEncoded: 90, impl: 'OpenH264' }, { rid: 'f', active: true, framesEncoded: 90, impl: 'OpenH264' }]);
        expect(await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: noSleep })).toBe('software');
        expect(lp.published[1].opts.videoCodec).toBe('vp8');
    });

    it('after a failure, the next Auto decision this session is VP8 without probing again', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        withSender(cam, [{ rid: 'f', active: true, framesEncoded: 0, impl: 'ExternalEncoder' }]);
        await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: noSleep });
        const cam2 = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp2 = fakeParticipant(cam2);
        await startCamera(lp2, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        expect(lp2.published[0].opts.videoCodec).toBe('vp8');
    });

    it('gone: the camera was turned off / replaced meanwhile → nothing happens', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        await lp.unpublishTrack(cam as never);
        expect(await watchHardwareCamera(lp, cam, { tier: 'auto', codec: hwH264, log: quiet, sleep: noSleep })).toBe('gone');
        expect(lp.published).toHaveLength(1);
    });
});

describe('recoverStalledCamera — the mid-call encoder watchdog\'s action', () => {
    it('a hardware H.264 camera whose encoder stopped is republished as VP8 and H.264 is not tried again this run', async () => {
        const cam = fakeCamera([{ width: 1920, height: 1080, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: hwH264, log: quiet, watchHardware: false });
        expect(lp.published[0].opts.videoCodec).toBe('h264');
        expect(await recoverStalledCamera(lp, { tier: 'auto', codec: hwH264, log: quiet })).toBe('recovered');
        expect(lp.published).toHaveLength(2);
        expect(lp.published[1].opts.videoCodec).toBe('vp8');
        expect(lp.unpublished).toEqual([cam]);
        expect(hasHwCameraFailed()).toBe(true);
        expect(getCameraPublishState()?.codec.reason).toMatch(/stopped mid-call/);
    });

    it('a software (VP8) camera has nowhere better to go: logged, left alone', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet, watchHardware: false });
        expect(await recoverStalledCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet })).toBe('not-hardware');
        expect(lp.published).toHaveLength(1);
        expect(lp.unpublished).toHaveLength(0);
        expect(hasHwCameraFailed()).toBe(false);
    });

    it('no camera published (turned off meanwhile) → gone, nothing happens', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        expect(await recoverStalledCamera(lp, { tier: 'auto', codec: hwH264, log: quiet })).toBe('gone');
        expect(lp.published).toHaveLength(0);
    });
});

describe('mid-call changes', () => {
    it('restartOptions carries the CURRENT device (LiveKit would otherwise fall back to "default")', () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }], 'usb-cam');
        expect(restartOptions(cam, '720p')).toEqual({ resolution: { width: 1280, height: 720, frameRate: 30 }, deviceId: { exact: 'usb-cam' } });
        const noDevice = { ...cam, constraints: {} } as CameraTrackLike;
        expect(restartOptions(noDevice, '480p')).toEqual({ resolution: { width: 854, height: 480, frameRate: 30 } });
    });

    it('retuneCamera rebuilds the ladder for the new capture size and asks LiveKit to recompute', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 30 }, { width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        cam.sender = {} as RTCRtpSender;
        cam.lastEncodedDimensions = { width: 2560, height: 1440 };
        cam.setTo(720); // switched to a 720p camera
        expect(await retuneCamera(cam)).toBe(true);
        expect(cam.refreshed).toBe(1);
        expect(cam.lastEncodedDimensions).toBeUndefined();
        expect(cam.publishOptions?.videoEncoding?.maxBitrate).toBe(2_000_000);
        expect(layerSizes(cam.publishOptions!)).toEqual(['320x180', '640x360']);
        expect(cam.publishOptions?.source).toBe(Track.Source.Camera); // the rest of the options kept
    });

    it('retuneCamera is a no-op before publish', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        expect(await retuneCamera(cam)).toBe(false);
        expect(await retuneCamera(undefined)).toBe(false);
    });

    it('applyCameraTier ("Lower to 720p"): restarts on the same device at 720p and re-tunes', async () => {
        const cam = fakeCamera([{ width: 1920, height: 1080, frameRate: 30 }, { width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        cam.sender = {} as RTCRtpSender;
        expect(await applyCameraTier(lp, '720p', quiet)).toBe(true);
        expect(cam.restarts[0]).toEqual({ resolution: { width: 1280, height: 720, frameRate: 30 }, deviceId: { exact: 'cam-1' } });
        expect(cam.publishOptions?.videoEncoding?.maxBitrate).toBe(2_000_000);
        expect(getCameraPublishState()?.tier).toBe('720p');
    });

    it('applyCameraTier with the camera off just returns false (the next publish uses the tier)', async () => {
        const lp = fakeParticipant(fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]));
        expect(await applyCameraTier(lp, '720p', quiet)).toBe(false);
    });
});

describe('settleCaptureMode', () => {
    it('gives up after two steps and keeps the last mode', async () => {
        const cam = fakeCamera([{ width: 2560, height: 1440, frameRate: 10 }, { width: 1920, height: 1080, frameRate: 10 }, { width: 1280, height: 720, frameRate: 10 }, { width: 854, height: 480, frameRate: 10 }]);
        const s = await settleCaptureMode(cam);
        expect(cam.restarts).toHaveLength(2);
        expect(s.height).toBe(720);
    });
    it('a restart that throws keeps what we have', async () => {
        const cam = fakeCamera([{ width: 1920, height: 1080, frameRate: 5 }]);
        cam.restartTrack = async () => { throw new Error('device gone'); };
        const s = await settleCaptureMode(cam);
        expect(s.height).toBe(1080);
    });
});

describe('toLiveKitPublishOptions / readCameraEncoderInfo', () => {
    it('lower layers become VideoPresets with bitrate and 30 fps', () => {
        const o = toLiveKitPublishOptions(cameraPublishPlan(1920, 1080, 'vp8'));
        expect(o.videoSimulcastLayers!.map(p => [p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate]))
            .toEqual([[480, 270, 380_000, 30], [960, 540, 1_200_000, 30]]);
    });

    it('reports codec, encoder, HW/SW and per-layer state for diagnostics', async () => {
        const cam = fakeCamera([{ width: 1280, height: 720, frameRate: 30 }]);
        const lp = fakeParticipant(cam);
        await startCamera(lp, { tier: 'auto', codec: vp8Only, log: quiet });
        cam.sender = {
            getParameters: () => ({ encodings: [{ rid: 'q', active: true }, { rid: 'f', active: false }] }),
            getStats: async () => new Map<string, unknown>([
                ['c', { type: 'codec', id: 'c', mimeType: 'video/VP8' }],
                ['q', { type: 'outbound-rtp', kind: 'video', rid: 'q', frameWidth: 320, frameHeight: 180, framesPerSecond: 30, encoderImplementation: 'libvpx', codecId: 'c' }],
                ['f', { type: 'outbound-rtp', kind: 'video', rid: 'f', frameWidth: 1280, frameHeight: 720, framesPerSecond: 0, encoderImplementation: 'libvpx', codecId: 'c' }],
            ]),
        } as unknown as RTCRtpSender;
        const info = await readCameraEncoderInfo(lp);
        expect(info).toMatchObject({ codec: 'video/VP8', encoderImplementation: 'libvpx', hardware: false, tier: 'auto' });
        expect(info!.layers.map(l => `${l.rid}:${l.active}`)).toEqual(['q:true', 'f:false']);
    });
});
