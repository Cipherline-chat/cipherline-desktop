import { describe, it, expect } from 'vitest';
import {
    CallSummaryAccumulator, InboundAudioStallDetector, INBOUND_STALL_MS, INBOUND_MAX_POLL_GAP_MS, durationBucket, percentile, transportFromRoute,
} from './callSummary';
import { WebrtcRing } from '../diagnostics/webrtcRing';

const T0 = 1_760_000_000_000;

describe('call summary helpers', () => {
    it('duration buckets are lower bounds', () => {
        expect([0, 29.9, 30, 59, 60, 299, 300, 899, 900, 1800, 3599, 3600, 7199, 7200, 99999].map(durationBucket))
            .toEqual([0, 0, 30, 30, 60, 60, 300, 300, 900, 1800, 1800, 3600, 3600, 7200, 7200]);
    });
    it('percentile: nearest rank, 0 when empty, ignores non-finite', () => {
        expect(percentile([], 50)).toBe(0);
        expect(percentile([5], 95)).toBe(5);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
        expect(percentile([NaN, 3, Infinity], 50)).toBe(3);
    });
    it('ICE protocol → transport', () => {
        expect(transportFromRoute('udp', false)).toBe('udp');
        expect(transportFromRoute('tcp', false)).toBe('tcp');
        expect(transportFromRoute('turn-udp', true)).toBe('turn_udp');
        expect(transportFromRoute('turn-tcp', true)).toBe('turn_tcp');
        expect(transportFromRoute('turn-tls', true)).toBe('turn_tcp');
        expect(transportFromRoute('udp', true)).toBe('turn_udp');
        expect(transportFromRoute(undefined, false)).toBe('unknown');
    });
});

describe('CallSummaryAccumulator', () => {
    it('builds the contract summary from ring samples and call events', () => {
        const acc = new CallSummaryAccumulator({ callType: 'group', e2ee: true, startedAt: T0 });
        acc.onCallEvent('call_join', { participants: 2 });
        acc.onCallEvent('participants', { count: 4 });
        acc.onCallEvent('ice_route', { pc: 'publisher', protocol: 'udp', turn: false });
        acc.onCallEvent('ice_route', { pc: 'subscriber', protocol: 'turn-tcp', turn: true });
        acc.onCallEvent('freeze_start', { track: 'remote-video-1' });
        acc.onCallEvent('freeze_start', { track: 'remote-video-1' });
        acc.onCallEvent('reconnecting');
        acc.onCallEvent('e2ee_decrypt_error', { reason: 'missing_key' });
        for (let i = 0; i < 10; i++) {
            acc.onSample({
                transport: { rtt_ms: 20 + i * 10, packet_loss_pct: i === 9 ? 12 : 0.5 },
                inbound: [
                    { track: 'remote-audio-1', kind: 'audio', codec: 'OPUS', jitter_ms: 3 + i },
                    { track: 'remote-video-1', kind: 'video', codec: 'VP8', fps: 30 - i },
                ],
                outbound: [
                    { track: 'mic-1', kind: 'audio', source: 'microphone', codec: 'OPUS' },
                    { track: 'camera-1', kind: 'video', source: 'camera', codec: 'H264', quality_limitation_reason: i < 4 ? 'cpu' : i < 6 ? 'bandwidth' : 'none' },
                ],
            }, T0 + i * 5000);
        }
        acc.noteFirstAudio(850);
        acc.noteFirstAudio(9999); // first one wins
        acc.noteEndReason('user');
        acc.noteEndReason('dropped'); // more specific wins
        acc.noteEndReason('remote');
        const s = acc.finish(T0 + 125_000);
        expect(s).toEqual({
            call_type: 'group',
            duration_s_bucket: 60,
            peers_max: 3,
            e2ee: true,
            audio_codec: 'opus',
            video_codec: 'h264',
            sent_video: true,
            screen_share: false,
            transport: 'turn_tcp',
            rtt_ms_p50: 60,
            rtt_ms_p95: 110,
            jitter_ms_p95: 12,
            loss_pct_p50: 0.5,
            loss_pct_p95: 12,
            video_freezes: 2,
            fps_p50: 25,
            cpu_limited_s: 15, // samples 1..3 (5 s each) after the first
            bw_limited_s: 10,
            reconnects: 1,
            e2ee_errors: 1,
            time_to_first_audio_ms: 850,
            end_reason: 'dropped',
        });
    });
    it('an empty call is still a valid summary (zeros, no optional fields, default reason)', () => {
        const s = new CallSummaryAccumulator({ callType: 'dm', e2ee: true, startedAt: T0 }).finish(T0 + 5_000);
        expect(s).toMatchObject({ duration_s_bucket: 0, peers_max: 0, audio_codec: 'unknown', transport: 'unknown', rtt_ms_p50: 0, end_reason: 'remote' });
        expect(s).not.toHaveProperty('video_codec');
        expect(s).not.toHaveProperty('fps_p50');
        expect(s).not.toHaveProperty('time_to_first_audio_ms');
    });
    it('a sampling gap (sleep, frozen renderer) is not counted as limited time', () => {
        const acc = new CallSummaryAccumulator({ callType: 'dm', e2ee: true, startedAt: T0 });
        const cpu = { inbound: [], outbound: [{ track: 'camera-1', kind: 'video' as const, source: 'camera' as const, quality_limitation_reason: 'cpu' as const }] };
        acc.onSample(cpu, T0);
        acc.onSample(cpu, T0 + 60_000);
        acc.onSample(cpu, T0 + 65_000);
        expect(acc.finish(T0 + 70_000).cpu_limited_s).toBe(5);
    });
    it('is fed by the real webrtcRing through its tap', () => {
        const ring = new WebrtcRing();
        const acc = new CallSummaryAccumulator({ callType: 'dm', e2ee: true, startedAt: T0 });
        ring.setTap((sample, at) => acc.onSample(sample, at));
        ring.beginCall();
        const mic = {};
        const pair = { id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.042 };
        ring.record(T0, [{ ref: mic, direction: 'inbound', kind: 'audio', report: [pair, { id: 'r', type: 'inbound-rtp', kind: 'audio', jitter: 0.004, packetsReceived: 100, packetsLost: 0, bytesReceived: 1000 }] }]);
        expect(acc.finish(T0 + 1000)).toMatchObject({ rtt_ms_p50: 42, jitter_ms_p95: 4 });
    });
});

describe('InboundAudioStallDetector', () => {
    const POLL = 5000; // BetaCallMonitor's cadence
    /** Poll every 5 s from `from` to `to` with the same reading; returns the first stall seen, with when. */
    function pollUntil(d: InboundAudioStallDetector, mk: (t: number) => Parameters<InboundAudioStallDetector['update']>[0], from: number, to: number) {
        for (let t = from; t <= to; t += POLL) {
            const r = d.update(mk(t), t);
            if (r) return { at: t, stall: r };
        }
        return null;
    }

    it('fires once when an unmuted remote mic gets no packets for 15 s of continuous polling', () => {
        const d = new InboundAudioStallDetector();
        const t = {};
        const hit = pollUntil(d, () => [{ ref: t, unmuted: true, packetsReceived: 10 }], 0, 60_000);
        expect(hit?.at).toBe(INBOUND_STALL_MS);
        expect(d.update([{ ref: t, unmuted: true, packetsReceived: 10 }], 70_000)).toBeNull(); // once per call
    });

    it('a muted mic, or one whose packets keep moving, never fires', () => {
        const d = new InboundAudioStallDetector();
        const muted = {}; const live = {};
        for (let i = 0; i <= 40; i++) {
            expect(d.update([
                { ref: muted, unmuted: false, packetsReceived: 0 },
                { ref: live, unmuted: true, packetsReceived: i * 50 },
            ], i * POLL)).toBeNull();
        }
    });

    it('unmuting restarts the clock', () => {
        const d = new InboundAudioStallDetector();
        const t = {};
        d.update([{ ref: t, unmuted: true, packetsReceived: 5 }], 0);
        d.update([{ ref: t, unmuted: false, packetsReceived: 5 }], 5_000);
        d.update([{ ref: t, unmuted: true, packetsReceived: 5 }], 10_000);
        expect(d.update([{ ref: t, unmuted: true, packetsReceived: 5 }], 15_000)).toBeNull();
        expect(d.update([{ ref: t, unmuted: true, packetsReceived: 5 }], 20_000)).toBeNull();
        expect(d.update([{ ref: t, unmuted: true, packetsReceived: 5 }], 25_000)).not.toBeNull();
    });

    describe('a polling gap is not evidence (sleep/wake, frozen renderer)', () => {
        it('a long pause between two polls with the same packet count does NOT fire', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            d.update([{ ref: t, unmuted: true, packetsReceived: 400 }], 0);
            d.update([{ ref: t, unmuted: true, packetsReceived: 400 }], POLL); // call went quiet right before the lid closed
            // laptop asleep for an hour; first poll after wake sees the same counter
            expect(d.update([{ ref: t, unmuted: true, packetsReceived: 400 }], 3_600_000)).toBeNull();
        });

        it('and observation restarts: a real stall after the wake still fires, 15 s later', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            d.update([{ ref: t, unmuted: true, packetsReceived: 400 }], 0);
            const wake = 3_600_000;
            d.update([{ ref: t, unmuted: true, packetsReceived: 400 }], wake);
            expect(pollUntil(d, () => [{ ref: t, unmuted: true, packetsReceived: 400 }], wake + POLL, wake + 60_000)?.at).toBe(wake + INBOUND_STALL_MS);
        });

        it('a gap at the limit is still continuous observation', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            const r = { ref: t, unmuted: true, packetsReceived: 1 };
            d.update([r], 0);
            d.update([r], INBOUND_MAX_POLL_GAP_MS);
            expect(d.update([r], INBOUND_MAX_POLL_GAP_MS * 2)).not.toBeNull();
        });
    });

    describe('says which leg is dead (booleans only)', () => {
        it('the SFU heard them speak while our packets stood still: sfuHears (our leg is the broken one)', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            const hit = pollUntil(d, (n) => [{ ref: t, unmuted: true, packetsReceived: 9, sfuSpeaking: n === 5_000 }], 0, 60_000);
            expect(hit?.stall).toEqual({ sfuHears: true, otherFlowing: false });
        });

        it('their camera/share packets kept arriving: otherFlowing (the connection is alive, only the mic stream stopped)', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            const hit = pollUntil(d, (n) => [{ ref: t, unmuted: true, packetsReceived: 9, otherPackets: 1000 + n / 10 }], 0, 60_000);
            expect(hit?.stall).toEqual({ sfuHears: false, otherFlowing: true });
        });

        it('nothing moved anywhere and the SFU never heard them: both false', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            const hit = pollUntil(d, () => [{ ref: t, unmuted: true, packetsReceived: 9, otherPackets: 1000, sfuSpeaking: false }], 0, 60_000);
            expect(hit?.stall).toEqual({ sfuHears: false, otherFlowing: false });
        });

        it('a peer with no other tracks (otherPackets undefined) reports otherFlowing false', () => {
            const d = new InboundAudioStallDetector();
            const t = {};
            const hit = pollUntil(d, () => [{ ref: t, unmuted: true, packetsReceived: 9 }], 0, 60_000);
            expect(hit?.stall?.otherFlowing).toBe(false);
        });
    });
});
