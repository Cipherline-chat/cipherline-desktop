import { describe, it, expect } from 'vitest';
import {
    summarizeSender, summarizeReceiver, isHardwareCodec, fpsTone, captureLimitHint, h264ProfileFromFmtp,
    bandwidthHint, BWE_RAMP_SECONDS, formatLayers,
    type StatsEntry,
} from './streamStatsHud';

// Canned reports shaped like Chromium's getStats() output (field names from
// the harness runs recorded in the branch commit message).

function senderReport(o: Partial<Record<string, unknown>> = {}, extra: StatsEntry[] = []): StatsEntry[] {
    return [
        { id: 'OT1', type: 'outbound-rtp', kind: 'video', codecId: 'C1', bytesSent: 1_000_000, framesEncoded: 900, totalEncodeTime: 3.6,
          keyFramesEncoded: 3, framesPerSecond: 89, frameWidth: 2560, frameHeight: 1440, qualityLimitationReason: 'none',
          qualityLimitationResolutionChanges: 0, targetBitrate: 24_000_000, encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
          powerEfficientEncoder: true, scalabilityMode: 'L1T1', nackCount: 2, pliCount: 1, ...o },
        { id: 'MS1', type: 'media-source', kind: 'video', framesPerSecond: 90, width: 2560, height: 1440 },
        { id: 'C1', type: 'codec', mimeType: 'video/H264' },
        { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' },
        { id: 'P1', type: 'candidate-pair', availableOutgoingBitrate: 40_000_000, currentRoundTripTime: 0.031, nominated: true, state: 'succeeded' },
        ...extra,
    ];
}

describe('summarizeSender', () => {
    it('reads capture, encode, encoder and link figures from one report', () => {
        const { stats, snapshot } = summarizeSender(senderReport(), null, 1000);
        expect(stats).toMatchObject({
            captureFps: 90, captureWidth: 2560, captureHeight: 1440,
            encodedFps: 89, encodedWidth: 2560, encodedHeight: 1440,
            codec: 'H264', encoder: 'MediaFoundationVideoEncodeAccelerator', hardware: true, scalabilityMode: 'L1T1',
            targetMbps: 24, availableMbps: 40, limitation: 'none', resolutionChanges: 0, keyFramesEncoded: 3,
            nacks: 2, plis: 1,
        });
        expect(stats.rttMs).toBeCloseTo(31);
        // Rates need two samples.
        expect(stats.sendMbps).toBeUndefined();
        expect(stats.encodeMs).toBeUndefined();
        expect(snapshot).toMatchObject({ at: 1000, bytesSent: 1_000_000, framesEncoded: 900 });
    });

    it('derives send rate and per-frame encode time from the previous snapshot', () => {
        const first = summarizeSender(senderReport(), null, 1000);
        const { stats } = summarizeSender(
            senderReport({ bytesSent: 1_000_000 + 3_000_000, framesEncoded: 990, totalEncodeTime: 3.6 + 0.36 }),
            first.snapshot, 2000,
        );
        expect(stats.sendMbps).toBeCloseTo(24);       // 3 MB in 1 s
        expect(stats.encodeMs).toBeCloseTo(4);        // 0.36 s over 90 frames
    });

    it('picks the highest-resolution layer for fps/size and sums bytes across simulcast layers', () => {
        const report: StatsEntry[] = [
            { id: 'L', type: 'outbound-rtp', kind: 'video', bytesSent: 100, framesPerSecond: 30, frameWidth: 320, frameHeight: 180, targetBitrate: 1e5 },
            { id: 'H', type: 'outbound-rtp', kind: 'video', bytesSent: 900, framesPerSecond: 29, frameWidth: 1280, frameHeight: 720, targetBitrate: 2e6 },
            { id: 'A', type: 'outbound-rtp', kind: 'audio', bytesSent: 5000 },
        ];
        const { stats, snapshot } = summarizeSender(report, null, 0);
        expect(stats.encodedWidth).toBe(1280);
        expect(stats.encodedFps).toBe(29);
        expect(stats.targetMbps).toBeCloseTo(2.1);
        expect(snapshot!.bytesSent).toBe(1000); // audio excluded
    });

    it('falls back to the nominated pair when there is no transport entry', () => {
        const report = senderReport().filter(s => s.type !== 'transport');
        expect(summarizeSender(report, null, 0).stats.availableMbps).toBe(40);
    });

    it('returns an empty result, not a throw, before the track has an outbound-rtp', () => {
        const { stats, snapshot } = summarizeSender([{ id: 'C1', type: 'codec', mimeType: 'video/VP8' }], null, 0);
        expect(stats).toEqual({ hardware: null });
        expect(snapshot).toBeNull();
    });

    it('accepts a Map-like RTCStatsReport (forEach) as well as an array', () => {
        const m = new Map(senderReport().map(s => [s.id, s]));
        expect(summarizeSender(m as unknown as Iterable<StatsEntry>, null, 0).stats.encodedFps).toBe(89);
    });
});

describe('summarizeReceiver', () => {
    const recv = (o: Partial<Record<string, unknown>> = {}): StatsEntry[] => [
        { id: 'IN', type: 'inbound-rtp', kind: 'video', codecId: 'C', bytesReceived: 2_000_000, framesDecoded: 1000, framesDropped: 10,
          totalDecodeTime: 2, jitterBufferDelay: 30, jitterBufferEmittedCount: 1000, packetsLost: 5, packetsReceived: 10_000,
          framesPerSecond: 88, frameWidth: 2560, frameHeight: 1440, decoderImplementation: 'D3D11VideoDecoder', freezeCount: 1,
          nackCount: 4, pliCount: 0, ...o },
        { id: 'C', type: 'codec', mimeType: 'video/VP9' },
    ];

    it('reads the receive-side picture and decoder', () => {
        const { stats } = summarizeReceiver(recv(), null, 0);
        expect(stats).toMatchObject({ fps: 88, width: 2560, height: 1440, codec: 'VP9', decoder: 'D3D11VideoDecoder', hardware: true, freezes: 1, framesDropped: 10 });
    });

    it('derives interval rates: Mbps, drops/s, jitter-buffer ms, decode ms, loss %', () => {
        const a = summarizeReceiver(recv(), null, 0);
        const { stats } = summarizeReceiver(recv({
            bytesReceived: 2_000_000 + 2_500_000, framesDecoded: 1090, framesDropped: 13, totalDecodeTime: 2 + 0.27,
            jitterBufferDelay: 30 + 3.6, jitterBufferEmittedCount: 1090, packetsLost: 5 + 3, packetsReceived: 10_000 + 297,
        }), a.snapshot, 1000);
        expect(stats.recvMbps).toBeCloseTo(20);
        expect(stats.droppedPerSec).toBeCloseTo(3);
        expect(stats.jitterBufferMs).toBeCloseTo(40);
        expect(stats.decodeMs).toBeCloseTo(3);
        expect(stats.lossPct).toBeCloseTo(1);
    });
});

describe('isHardwareCodec', () => {
    it.each([
        ['libvpx', undefined, false],
        ['OpenH264', undefined, false],
        ['FFmpeg', undefined, false],
        ['SimulcastEncoderAdapter (libvpx, libvpx)', undefined, false],
        ['MediaFoundationVideoEncodeAccelerator', undefined, true],
        ['ExternalEncoder', undefined, true],
        ['D3D11VideoDecoder', undefined, true],
        ['SomethingNew', undefined, null],
        [undefined, undefined, null],
        // The explicit powerEfficient flag always wins over the name.
        ['libvpx', true, true],
        ['ExternalEncoder', false, false],
    ] as const)('%s (powerEfficient=%s) → %s', (impl, pe, expected) => {
        expect(isHardwareCodec(impl, pe)).toBe(expected);
    });
});

describe('fpsTone', () => {
    it.each([
        [90, 90, 'ok'], [86, 90, 'ok'], [85, 90, 'warn'], [68, 90, 'warn'], [67, 90, 'bad'],
        [undefined, 90, 'neutral'], [60, undefined, 'neutral'], [60, 0, 'neutral'],
    ] as const)('%s fps against %s → %s', (fps, target, tone) => {
        expect(fpsTone(fps, target)).toBe(tone);
    });
});

describe('summarizeSender — negotiated fmtp', () => {
    it('carries the send codec\'s sdpFmtpLine so the H.264 profile is visible', () => {
        const fmtp = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
        const r = senderReport({}, []);
        (r.find(e => e.id === 'C1') as StatsEntry).sdpFmtpLine = fmtp;
        const { stats } = summarizeSender(r, null, 0);
        expect(stats.codecFmtp).toBe(fmtp);
        expect(h264ProfileFromFmtp(stats.codecFmtp)).toBe('CB');
    });
});

describe('h264ProfileFromFmtp', () => {
    it.each([
        ['profile-level-id=42e01f', 'CB'],          // LiveKit's CB
        ['packetization-mode=1;profile-level-id=42001f', 'Baseline'],
        ['profile-level-id=4d001f', 'Main'],
        ['profile-level-id=640032', 'High'],         // LiveKit's High
        ['profile-level-id=64001F', 'High'],
        ['profile-level-id=f4001f', 'High 4:4:4'],
        ['packetization-mode=1', undefined],
        [undefined, undefined],
    ] as const)('%s → %s', (fmtp, profile) => {
        expect(h264ProfileFromFmtp(fmtp)).toBe(profile);
    });
});

describe('captureLimitHint', () => {
    const base = { requestedFps: 90, encodedFps: 53, limitation: 'none' };

    // The owner's reading: 144 Hz display, 53 fps capture, encoder keeping up.
    it('without the capture log: capture-bound, with the grab time the CPU cap would imply', () => {
        const h = captureLimitHint({ ...base, captureFps: 53, displayHz: 144 });
        expect(h.verdict).toBe('capturer');
        expect(h.text).toContain('9.4ms');
    });

    it('with the log: 9-10 ms grabs every ~19 ms → Chromium CPU cap', () => {
        const h = captureLimitHint({
            ...base, captureFps: 53, displayHz: 144,
            timing: { captureMs: 9, periodMs: 19, unchangedRatio: 0 },
        });
        expect(h.verdict).toBe('throttle');
        expect(h.text).toMatch(/9ms ×2 → ≤53 fps/);
    });

    it('with the log: polled on time (11 ms) but frames missing → no new frame (content/capturer)', () => {
        const h = captureLimitHint({
            ...base, captureFps: 60, displayHz: 144,
            timing: { captureMs: 4, periodMs: 11, unchangedRatio: 0.33 },
        });
        expect(h.verdict).toBe('unchanged');
        expect(h.text).toMatch(/33%/);
    });

    it('with the log: grabs on time and all new, but WebRTC sees fewer → lost in between', () => {
        const h = captureLimitHint({
            ...base, captureFps: 50, displayHz: 144,
            timing: { captureMs: 4, periodMs: 11.2, unchangedRatio: 0 },
        });
        expect(h.verdict).toBe('pipeline');
        expect(h.text).toBe('Chromium grabbed 89/s, WebRTC got 50');
    });

    it('a 60 Hz display delivering ~60 of 90 is the display, not the capturer', () => {
        expect(captureLimitHint({ ...base, captureFps: 59, displayHz: 60 }).verdict).toBe('display');
    });

    it('a 144 Hz display is never blamed for a 90 fps request', () => {
        expect(captureLimitHint({ ...base, captureFps: 60, displayHz: 144 }).verdict).toBe('capturer');
    });

    it('capture on target, encoder short → encoder / network by limitation reason', () => {
        expect(captureLimitHint({ requestedFps: 90, captureFps: 89, encodedFps: 60, limitation: 'cpu' }).verdict).toBe('encoder');
        expect(captureLimitHint({ requestedFps: 90, captureFps: 89, encodedFps: 60, limitation: 'bandwidth' }).verdict).toBe('network');
    });

    it('everything on target → ok', () => {
        expect(captureLimitHint({ requestedFps: 90, captureFps: 88, encodedFps: 87, limitation: 'none' }).verdict).toBe('ok');
    });

    it('unknown without a capture rate or a request', () => {
        expect(captureLimitHint({ requestedFps: 90 }).verdict).toBe('unknown');
        expect(captureLimitHint({ captureFps: 50 }).verdict).toBe('unknown');
    });

    // The owner's DXGI test: capture 82 of 90, grab 3.6 ms, scheduled every
    // 11 ms, real 11.3–13.1 ms. The old reading ("capturer: poll 91/s, grab
    // 3.6ms") named no culprit; the grab is cheap, the TIMER is late.
    it('grabs cheap and on schedule, but the real interval is longer → the capture timer', () => {
        const h = captureLimitHint({
            ...base, captureFps: 82, displayHz: 200,
            timing: { captureMs: 3.6, periodMs: 11, unchangedRatio: 0, intervalMs: 12.1, requestedFps: 90 },
        });
        expect(h.verdict).toBe('timer');
        expect(h.text).toBe('capture timer late: every 11ms asked, 12.1ms real → 83 fps (no capture headroom)');
    });

    it('with capture headroom asked for (113 for a 90 target) the note about headroom goes', () => {
        const h = captureLimitHint({
            ...base, captureFps: 80, displayHz: 200,
            timing: { captureMs: 3.6, periodMs: 8, unchangedRatio: 0, intervalMs: 12.4, requestedFps: 113 },
        });
        expect(h.verdict).toBe('timer');
        expect(h.text).not.toMatch(/headroom/);
    });

    it('measures against the TARGET, not the paced capture request: 90 delivered of a 113 ask is on target', () => {
        expect(captureLimitHint({ requestedFps: 90, captureFps: 90, encodedFps: 90, limitation: 'none' }).verdict).toBe('ok');
    });

    it('a CPU-capped WGC grab still reads as the CPU cap even with a paced request (period ≠ 1000/113)', () => {
        const h = captureLimitHint({
            ...base, captureFps: 52, displayHz: 200,
            timing: { captureMs: 9.7, periodMs: 19.4, unchangedRatio: 0, intervalMs: 19.6, requestedFps: 113 },
        });
        expect(h.verdict).toBe('throttle');
    });
});

describe('bandwidthHint', () => {
    const owner = { limitation: 'bandwidth', availableMbps: 2.9, encodedWidth: 1280, encodedHeight: 720, captureWidth: 2560, captureHeight: 1440 };
    it('nothing when bandwidth is not the limiter', () => {
        expect(bandwidthHint({ ...owner, limitation: 'none' })).toBeNull();
        expect(bandwidthHint({ ...owner, limitation: 'cpu' })).toBeNull();
        expect(bandwidthHint({})).toBeNull();
    });
    it('early in the share: the estimate is still ramping (not a verdict on the link)', () => {
        expect(bandwidthHint({ ...owner, ageSec: 6 })).toBe('link 2.9 Mbps, still ramping (6s in) — sending 1280×720 to fit');
    });
    it(`after ${BWE_RAMP_SECONDS}s it has settled — that is the uplink`, () => {
        expect(bandwidthHint({ ...owner, ageSec: 45 })).toBe('link settled at 2.9 Mbps — likely your upload; sending 1280×720 to fit');
        expect(bandwidthHint({ ...owner })).toMatch(/settled/); // age unknown → no "ramping" excuse
    });
    it('full resolution but held back', () => {
        expect(bandwidthHint({ ...owner, encodedWidth: 2560, encodedHeight: 1440, availableMbps: 14.2, ageSec: 30 }))
            .toBe('link settled at 14 Mbps — likely your upload; encoder held back');
    });
});

describe('camera simulcast layers (dynacast)', () => {
    const layer = (rid: string, w: number, h: number, fps: number, active: boolean, impl = 'libvpx'): StatsEntry => ({
        id: `out-${rid}`, type: 'outbound-rtp', kind: 'video', rid, frameWidth: w, frameHeight: h, framesPerSecond: fps, active,
        bytesSent: 1000, framesEncoded: 10, totalEncodeTime: 0.1, encoderImplementation: impl,
    });

    it('a dynacast-paused top layer (last size still reported) is not shown as "encoded"', () => {
        const { stats } = summarizeSender([layer('q', 320, 180, 30, true), layer('h', 640, 360, 30, true), layer('f', 1280, 720, 0, false)], null, 1000);
        expect([stats.encodedWidth, stats.encodedHeight, stats.encodedFps]).toEqual([640, 360, 30]);
    });

    it('with every layer live, the top one is shown', () => {
        const { stats } = summarizeSender([layer('q', 320, 180, 30, true), layer('f', 1280, 720, 30, true)], null, 1000);
        expect(stats.encodedWidth).toBe(1280);
    });

    it('formats the ladder smallest first, paused layers as off', () => {
        const { stats } = summarizeSender([layer('f', 2560, 1440, 0, false), layer('q', 640, 360, 30, true), layer('h', 1280, 720, 29.6, true)], null, 1000);
        expect(formatLayers(stats.layers)).toBe('640×360 30 · 1280×720 30 · 2560×1440 off');
    });

    it('a single-layer sender (screen share) has no layers row', () => {
        const { stats } = summarizeSender([layer('', 1920, 1080, 60, true)], null, 1000);
        expect(stats.layers).toBeUndefined();
        expect(formatLayers(stats.layers)).toBeUndefined();
    });

    it('HW/SW comes from the active top layer', () => {
        const { stats } = summarizeSender([layer('q', 320, 180, 30, true, 'ExternalEncoder'), layer('f', 1280, 720, 30, true, 'ExternalEncoder')], null, 1000);
        expect(stats.hardware).toBe(true);
    });
});
