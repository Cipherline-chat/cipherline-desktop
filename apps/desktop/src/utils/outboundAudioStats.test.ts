import { describe, it, expect } from 'vitest';
import { readOutboundAudio, sourceRmsBetween } from './outboundAudioStats';

const report = (stats: Array<Record<string, unknown>>) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => stats.forEach(cb) });

// Shapes and numbers measured in Chromium 150 with a loopback RTCPeerConnection
// (a 0.1-amplitude tone through a WebAudio MediaStreamDestination), two getStats()
// calls 2 s apart.
const RUNNING_1 = [
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 2582, packetsSent: 32 },
    { type: 'media-source', kind: 'audio', audioLevel: 0.0999786370433668, totalAudioEnergy: 0.005497650325777102, totalSamplesDuration: 0.65 },
    { type: 'transport', bytesSent: 99999 },
];
const RUNNING_2 = [
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 10763, packetsSent: 133 },
    { type: 'media-source', kind: 'audio', audioLevel: 0.0999786370433668, totalAudioEnergy: 0.02558906333452615, totalSamplesDuration: 2.66 },
];
const SUSPENDED = [
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 0, packetsSent: 0 },
    { type: 'media-source', kind: 'audio', audioLevel: 0, totalAudioEnergy: 0, totalSamplesDuration: 0 },
];

describe('readOutboundAudio', () => {
    it('reads the audio sender counters and the encoder-source energy, ignoring other stats', () => {
        expect(readOutboundAudio(report(RUNNING_1))).toEqual({ bytesSent: 2582, energy: 0.005497650325777102, duration: 0.65 });
    });

    it('a suspended AudioContext reads as a sender that has sent nothing', () => {
        expect(readOutboundAudio(report(SUSPENDED))).toEqual({ bytesSent: 0, energy: 0, duration: 0 });
    });

    it('a report with no audio outbound-rtp (no sender, a video-only report, empty) is null, not zeros', () => {
        expect(readOutboundAudio(report([]))).toBeNull();
        expect(readOutboundAudio(report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 5 }]))).toBeNull();
        expect(readOutboundAudio(null)).toBeNull();
        expect(readOutboundAudio(undefined)).toBeNull();
        expect(readOutboundAudio({} as never)).toBeNull();
    });

    it('accepts the legacy mediaType spelling and tolerates a missing media-source', () => {
        expect(readOutboundAudio(report([{ type: 'outbound-rtp', mediaType: 'audio', bytesSent: 40 }]))).toEqual({ bytesSent: 40, energy: null, duration: null });
    });

    it('survives a throwing report and non-numeric fields', () => {
        expect(readOutboundAudio({ forEach: () => { throw new Error('closed'); } })).toBeNull();
        expect(readOutboundAudio(report([{ type: 'outbound-rtp', kind: 'audio', bytesSent: 'x' }]))).toBeNull();
    });
});

describe('sourceRmsBetween', () => {
    it('recovers the source RMS from two readings (the measured tone: 0.0999 for a 0.1 amplitude)', () => {
        const a = readOutboundAudio(report(RUNNING_1))!;
        const b = readOutboundAudio(report(RUNNING_2))!;
        expect(sourceRmsBetween(a, b)).toBeCloseTo(0.0999, 3);
        expect(b.bytesSent - a.bytesSent).toBeGreaterThan(0);
    });

    it('is null when nothing was fed (suspended), counters are missing, or they went backwards', () => {
        const z = readOutboundAudio(report(SUSPENDED))!;
        expect(sourceRmsBetween(z, z)).toBeNull();
        expect(sourceRmsBetween({ bytesSent: 1, energy: null, duration: null }, { bytesSent: 2, energy: 1, duration: 1 })).toBeNull();
        expect(sourceRmsBetween({ bytesSent: 1, energy: 5, duration: 5 }, { bytesSent: 2, energy: 1, duration: 6 })).toBeNull();
    });

    it('digital silence between two readings is exactly 0', () => {
        expect(sourceRmsBetween({ bytesSent: 1, energy: 2, duration: 4 }, { bytesSent: 2, energy: 2, duration: 5 })).toBe(0);
    });
});
