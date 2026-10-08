import { describe, it, expect } from 'vitest';
import { WebrtcRing, WEBRTC_RING_SIZE, type TrackStatsInput } from './webrtcRing';
import { gatherTrackStats, type RoomLike } from './webrtcRoomAdapter';
import type { StatsEntry } from '../streamStatsHud';

const SIDS = ['PA_participant01', 'TR_cameraTrack99', 'TR_screenTrack77', 'PA_remoteGuy42', 'TR_remoteVid55'];
const IDENTITY = 'user:3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b';

function outVideo(i: number, sid: string, extra: Partial<StatsEntry> = {}): StatsEntry[] {
    return [
        { id: `OUT_${sid}`, type: 'outbound-rtp', kind: 'video', trackIdentifier: sid, rid: 'f', ssrc: 99,
          frameWidth: 1920, frameHeight: 1080, framesPerSecond: 58, framesSent: 300 * i, framesEncoded: 300 * i, bytesSent: 5e6 * i,
          totalEncodeTime: i, encoderImplementation: 'ExternalEncoder (MediaFoundationVideoEncodeAccelerator)', qualityLimitationReason: 'bandwidth',
          qualityLimitationDurations: { none: 1, cpu: 0, bandwidth: 2 * i, other: 0 }, codecId: 'C1', nackCount: 3, pliCount: 0, ...extra },
        { id: 'C1', type: 'codec', mimeType: 'video/VP8' },
        { id: `SRC_${sid}`, type: 'media-source', kind: 'video', framesPerSecond: 60, trackIdentifier: sid },
        { id: 'CP', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05, availableOutgoingBitrate: 9e6, remoteCandidateId: '203.0.113.7' },
    ];
}
function inVideo(i: number, sid: string): StatsEntry[] {
    return [
        { id: `IN_${sid}`, type: 'inbound-rtp', kind: 'video', trackIdentifier: sid, frameWidth: 1280, frameHeight: 720, framesPerSecond: 29.97,
          bytesReceived: 1e6 * i, framesDecoded: 150 * i, framesDropped: i, packetsLost: 2 * i, packetsReceived: 1000 * i, jitter: 0.012,
          decoderImplementation: 'libvpx', freezeCount: 1, codecId: 'C3' },
        { id: 'C3', type: 'codec', mimeType: 'video/VP8' },
    ];
}

describe('WebrtcRing', () => {
    it('records how many encodings are active, so a dynacast pause reads differently from a dead encoder', () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        const cam = {};
        ring.record(0, [{ ref: cam, direction: 'outbound', kind: 'video', source: 'camera', report: outVideo(1, 'TR_c1234567', { active: true }) }]);
        ring.record(5000, [{ ref: cam, direction: 'outbound', kind: 'video', source: 'camera', report: outVideo(2, 'TR_c1234567', { active: false }) }]);
        const s = ring.summary(5000).samples;
        expect(s[0].outbound[0]).toMatchObject({ layers: 1, active_layers: 1 });
        expect(s[1].outbound[0]).toMatchObject({ layers: 1, active_layers: 0 });
        // Stats without the field (older Chromium) → omitted, never guessed.
        ring.record(10_000, [{ ref: cam, direction: 'outbound', kind: 'video', source: 'camera', report: outVideo(3, 'TR_c1234567') }]);
        expect(ring.summary(10_000).samples[2].outbound[0].active_layers).toBeUndefined();
    });

    it('maps every track to a role placeholder at capture time; no SID / identity in the buffer', () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        const cam = {}; const screen = {}; const remoteA = {}; const remoteB = {};
        for (let i = 1; i <= 3; i++) {
            ring.record(1000 * i * 5, [
                { ref: cam, direction: 'outbound', kind: 'video', source: 'camera', report: outVideo(i, SIDS[1]) },
                { ref: screen, direction: 'outbound', kind: 'video', source: 'screen_share', report: outVideo(i, SIDS[2]), targetFps: 90 },
                { ref: remoteA, direction: 'inbound', kind: 'video', report: inVideo(i, SIDS[4]) },
                { ref: remoteB, direction: 'inbound', kind: 'video', report: inVideo(i, `${IDENTITY}|${SIDS[3]}`) },
            ]);
        }
        const s = ring.summary(20_000);
        expect(s.samples[2].outbound.map(o => o.track)).toEqual(['camera-1', 'screen-1']);
        expect(s.samples[2].inbound.map(o => o.track)).toEqual(['remote-video-1', 'remote-video-2']);
        const json = JSON.stringify(s);
        for (const bad of [...SIDS, IDENTITY, '203.0.113.7', 'ssrc', 'rid', 'trackIdentifier']) expect(json).not.toContain(bad);
        // and the private storage itself carries no SID either
        expect(JSON.stringify((ring as unknown as { samples: unknown }).samples)).not.toMatch(/PA_|TR_|user:/);
    });

    it('computes the 90 fps evidence: target vs capture vs encoded vs sent, limitation, bitrate', () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        const screen = {};
        ring.record(0, [{ ref: screen, direction: 'outbound', kind: 'video', source: 'screen_share', report: outVideo(1, 'TR_x1234567'), targetFps: 90 }]);
        ring.record(5000, [{ ref: screen, direction: 'outbound', kind: 'video', source: 'screen_share', report: outVideo(2, 'TR_x1234567'), targetFps: 90 }]);
        const o = ring.summary(5000).samples[1].outbound[0];
        expect(o).toMatchObject({
            track: 'screen-1', kind: 'video', source: 'screen_share', codec: 'VP8', hardware: true,
            target_fps: 90, capture_fps: 60, encoded_fps: 58, sent_fps: 60, width: 1920, height: 1080,
            quality_limitation_reason: 'bandwidth', quality_limitation_s: { none: 1, cpu: 0, bandwidth: 4, other: 0 },
            bitrate_kbps: 8000, nack_count: 3, pli_count: 0,
        });
        expect(ring.summary(5000).samples[1].transport).toMatchObject({ rtt_ms: 50, available_outgoing_kbps: 9000 });
    });

    it(`keeps a ${WEBRTC_RING_SIZE}-sample window (newest), oldest first, t_s relative`, () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        const t = {};
        for (let i = 1; i <= 40; i++) ring.record(i * 5000, [{ ref: t, direction: 'inbound', kind: 'video', report: inVideo(i, 'TR_aaaaaaaaa') }]);
        const s = ring.summary(200_000);
        expect(s.samples).toHaveLength(WEBRTC_RING_SIZE);
        expect(s.samples[0].t_s).toBe(-(200_000 - 17 * 5000) / 1000);
        expect(s.samples.at(-1)!.t_s).toBe(0);
    });

    it('stops after the call ends, keeps the last call with its end time, and a new call starts fresh', () => {
        const ring = new WebrtcRing();
        expect(ring.summary(0)).toEqual({ call_active: false, samples: [] });
        ring.beginCall();
        const t = {};
        ring.record(1000, [{ ref: t, direction: 'inbound', kind: 'video', report: inVideo(1, 'TR_aaaaaaaaa') }]);
        ring.endCall(2000);
        ring.record(3000, [{ ref: t, direction: 'inbound', kind: 'video', report: inVideo(2, 'TR_aaaaaaaaa') }]);
        const s = ring.summary(62_000);
        expect(s.call_active).toBe(false);
        expect(s.seconds_since_call_end).toBe(60);
        expect(s.samples).toHaveLength(1);
        ring.beginCall();
        expect(ring.summary(70_000)).toEqual({ call_active: true, samples: [] });
        // placeholders restart per call
        ring.record(71_000, [{ ref: {}, direction: 'inbound', kind: 'video', report: inVideo(1, 'TR_bbbbbbbbb') }]);
        expect(ring.summary(71_000).samples[0].inbound[0].track).toBe('remote-video-1');
    });

    it('caps tracks per sample and survives a broken report', () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        const tracks: TrackStatsInput[] = Array.from({ length: 12 }, () => ({ ref: {}, direction: 'inbound', kind: 'audio', report: [] }));
        tracks.push({ ref: {}, direction: 'inbound', kind: 'video', report: { forEach: () => { throw new Error('gone'); } } });
        ring.record(0, tracks);
        expect(ring.summary(0).samples[0].inbound.length).toBe(8);
    });

    it('a capture description never carries a source id or title', () => {
        const ring = new WebrtcRing();
        ring.beginCall();
        ring.setCapture({ kind: 'window', requestedFps: 60, requestedResolution: 'Dawson secret doc.docx', codecPref: 'auto' });
        const s = ring.summary(0);
        expect(s.capture).toEqual({ kind: 'window', requested_fps: 60, codec_pref: 'auto' });
    });
});

describe('gatherTrackStats (LiveKit room adapter)', () => {
    const report = (entries: StatsEntry[]) => ({ forEach: (cb: (s: StatsEntry) => void) => entries.forEach(cb) });
    const pubs = (list: unknown[]) => ({ forEach: (cb: (p: never) => void) => list.forEach(p => cb(p as never)) });

    it('reads source + kind + the track object only; skips unsubscribed and failing tracks', async () => {
        const screenTrack = {
            kind: 'video', sid: 'TR_screenTrack77', name: 'Dawson screen',
            getRTCStatsReport: async () => report(outVideo(1, 'TR_screenTrack77')),
            sender: { getParameters: () => ({ encodings: [{ active: true, maxFramerate: 90, maxBitrate: 25_000_000 }] }) },
        };
        const micTrack = { kind: 'audio', getRTCStatsReport: async () => report([]) };
        const remoteVideo = { kind: 'video', getRTCStatsReport: async () => report(inVideo(1, 'TR_remoteVid55')) };
        const remoteAudio = { kind: 'audio', getRTCStatsReport: async () => report([]) };
        const broken = { kind: 'video', getRTCStatsReport: async () => { throw new Error('ended'); } };
        const room: RoomLike = {
            localParticipant: { trackPublications: pubs([
                { source: 'screen_share', kind: 'video', track: screenTrack, trackSid: 'TR_screenTrack77' },
                { source: 'microphone', kind: 'audio', track: micTrack },
                { source: 'camera', kind: 'video', track: null },
            ]) },
            remoteParticipants: { forEach: (cb) => cb({ trackPublications: pubs([
                { kind: 'audio', track: remoteAudio, isSubscribed: true },
                { kind: 'video', track: remoteVideo, isSubscribed: true },
                { kind: 'video', track: broken, isSubscribed: true },
                { kind: 'video', track: remoteVideo, isSubscribed: false },
            ]) }) },
        };
        const inputs = await gatherTrackStats(room, { screenShareTargetFps: 90 });
        expect(inputs.map(i => [i.direction, i.kind, i.source ?? '-'])).toEqual([
            ['outbound', 'video', 'screen_share'], ['outbound', 'audio', 'microphone'],
            ['inbound', 'video', '-'], ['inbound', 'audio', '-'],
        ]);
        expect(inputs[0]).toMatchObject({ targetFps: 90, maxBitrateBps: 25_000_000 });
        expect(inputs[0].ref).toBe(screenTrack);
        // Fed through the ring: still no SID or name.
        const ring = new WebrtcRing();
        ring.beginCall();
        ring.record(0, inputs);
        expect(JSON.stringify(ring.summary(0))).not.toMatch(/TR_|PA_|Dawson/);
    });

    it('an empty / absent room yields nothing', async () => {
        expect(await gatherTrackStats({})).toEqual([]);
    });
});
