import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    noteLinuxHwEncodeFailure, linuxHwEncodeDistrusted, linuxEncoderIsHardware, noteShareEncoderSample,
    lastShareEncoderWasHardware, __setLinuxHwEncodeEnvForTests, type LinuxHwFailureKind,
} from './linuxHwEncode';
import {
    probeHardwareEncoders, decideScreenShareCodec, markH264HighFailed, resetH264HighFailedForTests,
    type HardwareEncoderSupport,
} from './screenShare';
import { ShareSoftwareGuard, SOFTWARE_SAMPLES_TO_ACT } from './shareSoftwareGuard';
import { ShareCodecDriftWatch, type StatsLike } from './shareCodecDrift';
import { getCallEvents, clearCallEvents } from './callEventLog';

function env(over: { linux?: boolean; active?: boolean | null } = {}) {
    const report = vi.fn(async (_k: LinuxHwFailureKind) => true);
    __setLinuxHwEncodeEnvForTests({
        isLinux: () => over.linux ?? true,
        featureActive: async () => (over.active === undefined ? true : over.active),
        report,
    });
    return report;
}

/** MediaCapabilities answering "hardware" for H.264 CB, VP8 and H.264 High, like a working VA-API machine. */
const hwInfo = async (c: { video: { contentType: string } }) => ({ supported: true, powerEfficient: !/VP9/i.test(c.video.contentType) });

beforeEach(() => {
    __setLinuxHwEncodeEnvForTests(null);
    resetH264HighFailedForTests();
    clearCallEvents();
});

describe('linuxEncoderIsHardware', () => {
    it.each([
        ['VaapiVideoEncodeAccelerator', undefined, true],
        ['SimulcastEncoderAdapter (VaapiVideoEncodeAccelerator, VaapiVideoEncodeAccelerator)', undefined, true],
        ['ExternalEncoder', undefined, true],
        ['libvpx', undefined, false],
        ['OpenH264', undefined, false],
        ['SimulcastEncoderAdapter (libvpx, libvpx)', undefined, false],
        ['libaom', undefined, false],
        ['SomethingNew', undefined, null],
        [undefined, undefined, null],
        ['libvpx', true, true],   // powerEfficientEncoder wins when present
        ['VaapiVideoEncodeAccelerator', false, false],
    ])('%s / %s -> %s', (name, pe, want) => expect(linuxEncoderIsHardware(name as string | undefined, pe)).toBe(want));
});

describe('probeHardwareEncoders - the session fallback', () => {
    it('reports what MediaCapabilities says until a hardware failure is counted', async () => {
        env();
        const hw = await probeHardwareEncoders(1920, 1080, 60, hwInfo);
        expect(hw).toMatchObject({ h264: true, vp8: true, h264High: true, vp9: false });
        expect(linuxHwEncodeDistrusted()).toBe(false);
    });

    it('after a counted failure the probe answers "no hardware" for every codec, so the next decision is software VP8', async () => {
        env();
        expect(await noteLinuxHwEncodeFailure('hw_lost', { codec: 'h264' })).toBe('counted');
        expect(linuxHwEncodeDistrusted()).toBe(true);
        const hw = (await probeHardwareEncoders(1920, 1080, 60, hwInfo)) as HardwareEncoderSupport;
        expect(hw).toEqual({ h264: false, vp9: false, vp8: false, h264High: false });
        expect(decideScreenShareCodec('auto', hw, [{ vendor: 'Intel' }])).toMatchObject({ codec: 'vp8', reason: 'auto: no HW encoder → VP8' });
    });

    it('a forced codec still wins (a tester A/B-ing codecs)', async () => {
        env();
        await noteLinuxHwEncodeFailure('hw_lost');
        const hw = await probeHardwareEncoders(1920, 1080, 60, hwInfo);
        expect(decideScreenShareCodec('vp9', hw).codec).toBe('vp9');
    });
});

describe('the codec preference on Linux (decideScreenShareCodec, unchanged by design)', () => {
    const intel = [{ vendor: 'Intel' }];
    const amd = [{ vendor: 'AMD' }];
    it('VA-API hardware H.264 Constrained Baseline is preferred (Arch / CachyOS / openSUSE shape)', () => {
        expect(decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: true, h264High: true }, intel))
            .toEqual({ codec: 'h264', h264Profile: 'cb', reason: 'auto: HW H.264' });
        expect(decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: false, h264High: true }, amd).codec).toBe('h264');
    });
    it('only High as hardware -> High (it is the hardware encoder; the start watch guards it)', () => {
        expect(decideScreenShareCodec('auto', { h264: false, vp9: false, vp8: false, h264High: true }, intel))
            .toMatchObject({ codec: 'h264', h264Profile: 'high' });
    });
    it('hardware VP8 only (a driver with VP8 but no H.264 encode) -> VP8, not VP9 software', () => {
        expect(decideScreenShareCodec('auto', { h264: false, vp9: false, vp8: true, h264High: false }, intel).codec).toBe('vp8');
    });
    it('no hardware at all (Ubuntu free iHD, Fedora, NVIDIA on Linux) -> VP8 exactly as before', () => {
        expect(decideScreenShareCodec('auto', { h264: false, vp9: false, vp8: false, h264High: false }, [{ vendor: 'NVIDIA' }]))
            .toEqual({ codec: 'vp8', reason: 'auto: no HW encoder → VP8' });
        expect(decideScreenShareCodec('auto', null)).toMatchObject({ codec: 'vp8' });
    });
    it('the Windows Media Foundation rule "NVIDIA primary -> High" is left alone: on Linux the GPU Chromium encodes on is index 0, and a probe that says hardware there is only ever true if VA-API really encodes', () => {
        const d = decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: true, h264High: true }, [{ vendor: 'NVIDIA' }, { vendor: 'Intel' }]);
        expect(d).toMatchObject({ codec: 'h264', h264Profile: 'high' });
    });
    it('a hardware CB share that turns out to be software still falls to VP8 (cbSoftware) - the drift / guard logic is untouched', () => {
        expect(decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: false, h264High: false }, intel, { cbSoftware: true }).codec).toBe('vp8');
    });
});

describe('noteLinuxHwEncodeFailure - what counts', () => {
    it('does nothing off Linux', async () => {
        const report = env({ linux: false });
        expect(await noteLinuxHwEncodeFailure('hw_lost')).toBe('ignored');
        expect(report).not.toHaveBeenCalled();
        expect(linuxHwEncodeDistrusted()).toBe(false);
    });

    it('does nothing when this launch has hardware encode off, or main did not say (older main)', async () => {
        for (const active of [false, null]) {
            const report = env({ active });
            expect(await noteLinuxHwEncodeFailure('high_start')).toBe('ignored');
            expect(report).not.toHaveBeenCalled();
            expect(linuxHwEncodeDistrusted()).toBe(false);
        }
    });

    it('counts a hardware failure once per kind: arms the session fallback, tells main one word, logs one call event', async () => {
        const report = env();
        expect(await noteLinuxHwEncodeFailure('stall', { codec: 'h264', encoder: 'VaapiVideoEncodeAccelerator' })).toBe('counted');
        expect(await noteLinuxHwEncodeFailure('stall', { codec: 'h264' })).toBe('repeat');
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith('stall');
        const ev = getCallEvents().filter(e => e.kind === 'linux_hw_encode');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ reason: 'stall', codec: 'h264', enc: 'VaapiVideoEncodeAccelerator' });
    });

    it('a stall from a SOFTWARE encoder is not evidence against VA-API; a stall with no encoder name (never opened) is', async () => {
        env();
        expect(await noteLinuxHwEncodeFailure('stall', { encoder: 'OpenH264' })).toBe('ignored');
        expect(await noteLinuxHwEncodeFailure('stall', { encoder: 'libvpx' })).toBe('ignored');
        expect(linuxHwEncodeDistrusted()).toBe(false);
        expect(await noteLinuxHwEncodeFailure('stall', {})).toBe('counted');
    });

    it('a drift counts only when the share was known to be on a hardware encoder', async () => {
        env();
        expect(await noteLinuxHwEncodeFailure('drift', { codec: 'h264', encoder: 'libvpx' })).toBe('ignored'); // sender went to VP8; was it hardware before? unknown
        noteShareEncoderSample(false);
        expect(await noteLinuxHwEncodeFailure('drift', { codec: 'h264', encoder: 'libvpx' })).toBe('ignored');
        noteShareEncoderSample(true);
        expect(lastShareEncoderWasHardware()).toBe(true);
        expect(await noteLinuxHwEncodeFailure('drift', { codec: 'h264', encoder: 'libvpx' })).toBe('counted');
    });

    it('a failed report to main never undoes the session fallback and never throws', async () => {
        __setLinuxHwEncodeEnvForTests({ isLinux: () => true, featureActive: async () => true, report: async () => { throw new Error('ipc gone'); } });
        await expect(noteLinuxHwEncodeFailure('hw_lost')).resolves.toBe('counted');
        expect(linuxHwEncodeDistrusted()).toBe(true);
    });

    it('the call event carries only fixed words, a codec name and an encoder implementation name', async () => {
        env();
        await noteLinuxHwEncodeFailure('hw_lost', { codec: 'vp8', encoder: 'VaapiVideoEncodeAccelerator' });
        const e = getCallEvents().find(x => x.kind === 'linux_hw_encode')!;
        expect(Object.keys(e.detail ?? {}).sort()).toEqual(['codec', 'enc', 'reason']);
    });
});

describe('the detectors that feed it', () => {
    it('markH264HighFailed (High has no software twin) counts as a hardware failure on Linux', async () => {
        const report = env();
        markH264HighFailed();
        await vi.waitFor(() => expect(report).toHaveBeenCalledWith('high_start'));
        expect(linuxHwEncodeDistrusted()).toBe(true);
    });

    it('ShareSoftwareGuard: a share whose samples said hardware and then software for SOFTWARE_SAMPLES_TO_ACT samples is hw_lost', async () => {
        const report = env();
        const g = new ShareSoftwareGuard({ codec: 'vp8', targetFps: 60, highHw: false, highFailed: false });
        g.observe(true);
        g.observe(true);
        expect(report).not.toHaveBeenCalled();
        for (let i = 0; i < SOFTWARE_SAMPLES_TO_ACT - 1; i++) g.observe(false, { encFps: 60, srcFps: 60 });
        expect(report).not.toHaveBeenCalled();
        g.observe(false, { encFps: 60, srcFps: 60 });
        await vi.waitFor(() => expect(report).toHaveBeenCalledWith('hw_lost'));
        expect(lastShareEncoderWasHardware()).toBe(false);
    });

    it('ShareSoftwareGuard: a share that was software from its first sample is NOT a hardware failure (nothing changes vs today)', async () => {
        const report = env();
        const g = new ShareSoftwareGuard({ codec: 'vp8', targetFps: 60, highHw: false, highFailed: false });
        for (let i = 0; i < 6; i++) g.observe(false, { encFps: 45, srcFps: 60 });
        await Promise.resolve();
        expect(report).not.toHaveBeenCalled();
        expect(linuxHwEncodeDistrusted()).toBe(false);
    });

    it('ShareSoftwareGuard: unknown hardware (null) never counts either way', async () => {
        const report = env();
        const g = new ShareSoftwareGuard({ codec: 'h264', profile: 'cb', targetFps: 60, highHw: false, highFailed: false });
        g.observe(true);
        for (let i = 0; i < 6; i++) g.observe(null);
        await Promise.resolve();
        expect(report).not.toHaveBeenCalled();
    });

    it('ShareCodecDriftWatch: a confirmed drift after a hardware sample is a hardware failure, and onDrift still fires', async () => {
        const report = env();
        noteShareEncoderSample(true);
        const stats: StatsLike = {
            forEach: cb => {
                cb({ type: 'codec', id: 'C1', mimeType: 'video/VP8' });
                cb({ type: 'outbound-rtp', kind: 'video', active: true, codecId: 'C1', frameWidth: 1920, frameHeight: 1080, encoderImplementation: 'libvpx' });
            },
        };
        const onDrift = vi.fn();
        const w = new ShareCodecDriftWatch({ getStats: async () => stats, published: 'h264', onDrift, sleep: async () => {} });
        await w.start();
        expect(onDrift).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(report).toHaveBeenCalledWith('drift'));
    });
});
