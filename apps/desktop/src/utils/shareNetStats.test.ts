import { describe, it, expect } from 'vitest';
import { readShareNetSnapshot, buildShareNetDetail, netCountersReset, capKbpsFromEncodings, type ShareNetSnapshot } from './shareNetStats';

const report = (entries: Record<string, unknown>[]) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => entries.forEach(cb) });

// A sender report full of things that must never be copied.
const NETWORK_SECRETS = ['203.0.113.77', '192.168.1.20', '2001:db8::1', 'RTCIceCandidate_ab12cd', 'LOCALCAND_9', 'REMOTECAND_9', 'ufragSECRET', '51234'];
const full = (o: { bytes?: number; frames?: number; encT?: number; ts?: number } = {}) => report([
    { id: 'OUT_hi', type: 'outbound-rtp', kind: 'video', ssrc: 111, active: true, frameWidth: 2560, frameHeight: 1440, timestamp: o.ts ?? 10_000,
      bytesSent: o.bytes ?? 12_500_000, framesEncoded: o.frames ?? 900, totalEncodeTime: o.encT ?? 4.5 },
    { id: 'OUT_lo', type: 'outbound-rtp', kind: 'video', ssrc: 222, active: true, frameWidth: 1280, frameHeight: 720, timestamp: o.ts ?? 10_000,
      bytesSent: 1_000_000, framesEncoded: 300, totalEncodeTime: 0.6 },
    { id: 'OUT_off', type: 'outbound-rtp', kind: 'video', ssrc: 333, active: false, frameWidth: 640, frameHeight: 360, bytesSent: 99_999_999, framesEncoded: 99999, totalEncodeTime: 999 },
    { id: 'RIR_hi', type: 'remote-inbound-rtp', kind: 'video', ssrc: 111, fractionLost: 0.031, roundTripTime: 0.0421 },
    { id: 'RIR_lo', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, fractionLost: 0.5, roundTripTime: 0.3 },
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP_sel', dtlsState: 'connected' },
    { id: 'CP_other', type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 1_000, localCandidateId: 'LOCALCAND_0', remoteCandidateId: 'REMOTECAND_0' },
    { id: 'CP_sel', type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 38_400_000, currentRoundTripTime: 0.05,
      localCandidateId: 'LOCALCAND_9', remoteCandidateId: 'REMOTECAND_9' },
    { id: 'LOCALCAND_9', type: 'local-candidate', address: '192.168.1.20', port: 51234, candidateType: 'host', usernameFragment: 'ufragSECRET', url: 'turn:203.0.113.77' },
    { id: 'REMOTECAND_9', type: 'remote-candidate', address: '203.0.113.77', ip: '2001:db8::1', port: 51234, id2: 'RTCIceCandidate_ab12cd' },
]);

describe('readShareNetSnapshot', () => {
    it('sums the ACTIVE layers, takes loss/RTT from the top layer\'s receiver report and the bandwidth from the selected pair', () => {
        const s = readShareNetSnapshot(full(), 1)!;
        expect(s).toMatchObject({ at: 10_000, layerSet: '-|-', bytesSent: 13_500_000, framesEncoded: 1200, totalEncodeTime: 5.1, availBps: 38_400_000, rttMs: 42.1, lossPct: 3.1 });
        expect(s.top).toBeDefined(); // the top layer on its own (largest picture), for share_net's top_* keys
    });
    it('falls back to the pair\'s RTT, and to the nominated pair without a transport selection', () => {
        const r = report([
            { type: 'outbound-rtp', kind: 'video', ssrc: 1, bytesSent: 1, framesEncoded: 1, totalEncodeTime: 0.01 },
            { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 5_000_000, currentRoundTripTime: 0.02 },
        ]);
        expect(readShareNetSnapshot(r, 5)).toMatchObject({ at: 5, availBps: 5_000_000, rttMs: 20 });
        expect(readShareNetSnapshot(r, 5)!.lossPct).toBeUndefined();
    });
    it('null with no video outbound-rtp', () => {
        expect(readShareNetSnapshot(report([{ type: 'candidate-pair' }]), 1)).toBeNull();
        expect(readShareNetSnapshot(undefined, 1)).toBeNull();
    });
    it('PRIVACY: nothing identifying survives into the snapshot or any detail built from it', () => {
        const a = readShareNetSnapshot(full({ ts: 0, bytes: 0, frames: 0, encT: 0 }), 1)!;
        const b = readShareNetSnapshot(full({ ts: 10_000 }), 1)!;
        const d = buildShareNetDetail(a, b, { shareRef: 'a1b2c3d4', capKbps: 12_000 })!;
        const text = JSON.stringify([a, b, d]);
        for (const secret of NETWORK_SECRETS) expect(text, secret).not.toContain(secret);
        expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // no IPv4
        expect(Object.keys(a).sort()).toEqual(['at', 'availBps', 'bytesSent', 'framesEncoded', 'layerSet', 'lossPct', 'rttMs', 'top', 'totalEncodeTime']);
    });
});

describe('buildShareNetDetail', () => {
    const prev: ShareNetSnapshot = { at: 0, bytesSent: 0, framesEncoded: 0, totalEncodeTime: 0, availBps: 30_000_000, rttMs: 40, lossPct: 0 };
    const cur: ShareNetSnapshot = { at: 10_000, bytesSent: 12_500_000, framesEncoded: 800, totalEncodeTime: 4, availBps: 38_400_000, rttMs: 42.4, lossPct: 3.1 };
    it('kbps from payload bytes, enc_ms per frame, the rest instantaneous', () => {
        expect(buildShareNetDetail(prev, cur, { shareRef: 'a1b2c3d4', capKbps: 16000 })).toEqual({
            share_ref: 'a1b2c3d4', kbps: 10_000, cap_kbps: 16_000, avail_kbps: 38_400, rtt_ms: 42, loss_pct: 3.1, enc_ms: 5,
        });
    });
    it('omits what the report did not have', () => {
        const d = buildShareNetDetail({ ...prev, availBps: undefined }, { at: 10_000, bytesSent: 1_250_000, framesEncoded: 0, totalEncodeTime: 0 }, {})!;
        expect(d).toEqual({ kbps: 1_000 });
    });
    it('a reset (republish restarts the counters), the first sample and a short window are null - never a rate', () => {
        const reset: ShareNetSnapshot = { at: 10_000, bytesSent: 5_000, framesEncoded: 3, totalEncodeTime: 0.01 };
        expect(netCountersReset({ ...prev, bytesSent: 9e6, framesEncoded: 500, totalEncodeTime: 3 }, reset)).toBe(true);
        expect(buildShareNetDetail({ ...prev, bytesSent: 9e6, framesEncoded: 500, totalEncodeTime: 3 }, reset, {})).toBeNull();
        expect(buildShareNetDetail(null, cur, {})).toBeNull();
        expect(buildShareNetDetail(prev, { ...cur, at: 100 }, {})).toBeNull();
    });
});

// Reports 4667c6fa / 14a5184a (1.0.24-staging.179): right after dynacast turned the
// full layer back ON, share_net said kbps=73667 / 94639 / 111528 on a 24 Mbps cap and
// share_fps said enc_fps=646..766 on a 90 fps share. The snapshot SUMS the active
// layers; a layer that was paused is missing from the previous sum, so its whole
// cumulative bytes / frames since the share began landed in one window.
describe('a layer that dynacast paused and resumed is not one giant window', () => {
    const layer = (rid: string, o: { active?: boolean; bytes: number; frames: number; encT: number; ts: number; w: number; h: number }) => ({
        type: 'outbound-rtp', kind: 'video', rid, ssrc: rid === 'q' ? 1 : 2, active: o.active ?? true,
        frameWidth: o.w, frameHeight: o.h, timestamp: o.ts, bytesSent: o.bytes, framesEncoded: o.frames, totalEncodeTime: o.encT,
    });
    // t=0: only q (h paused 20 s ago, 92 MB / 6600 frames sent before that). t=10 s: h active again.
    const qOnly = (ts: number, bytes: number) => report([
        layer('q', { bytes, frames: 300, encT: 1, ts, w: 1280, h: 720 }),
        layer('h', { active: false, bytes: 92_000_000, frames: 6600, encT: 60, ts, w: 2560, h: 1440 }),
    ]);
    const both = (ts: number) => report([
        layer('q', { bytes: 2_800_000, frames: 600, encT: 2, ts, w: 1280, h: 720 }),
        layer('h', { bytes: 92_300_000, frames: 6610, encT: 60.1, ts, w: 2560, h: 1440 }),
    ]);

    it('the window that spans the layer set changing is skipped (null), never reported as ~74 Mbps', () => {
        const a = readShareNetSnapshot(qOnly(0, 500_000), 0)!;
        const b = readShareNetSnapshot(both(10_000), 10_000)!;
        expect(buildShareNetDetail(a, b, { capKbps: 24_200 })).toBeNull();
    });

    it('the next window, with the same layers on both ends, is a normal rate over BOTH layers', () => {
        const b = readShareNetSnapshot(both(10_000), 10_000)!;
        const c = readShareNetSnapshot(report([
            layer('q', { bytes: 3_050_000, frames: 900, encT: 3, ts: 20_000, w: 1280, h: 720 }),
            layer('h', { bytes: 95_000_000, frames: 7500, encT: 64, ts: 20_000, w: 2560, h: 1440 }),
        ]), 20_000)!;
        const d = buildShareNetDetail(b, c, { capKbps: 24_200 })!;
        expect(d.kbps).toBe(Math.round(((3_050_000 - 2_800_000 + 95_000_000 - 92_300_000) * 8) / 10 / 1000));
        expect(d.kbps).toBeLessThan(24_200);
    });

    it('negative control: a steady two-layer window is unchanged', () => {
        const a = readShareNetSnapshot(both(0), 0)!;
        const b = readShareNetSnapshot(both(10_000), 10_000)!;
        expect(buildShareNetDetail(a, b, {})).not.toBeNull();
    });

    it('the layer set leaves no identifier in the snapshot (rid letters only, no ssrc)', () => {
        const s = readShareNetSnapshot(both(0), 0)!;
        expect(JSON.stringify(s)).not.toMatch(/ssrc/i);
        expect(s.layerSet).toBe('h|q');
    });
});

describe('top-layer keys (share_net): the lighter copy no longer hides the full layer', () => {
    // The full 3024x1964 layer nearly silent (a still screen / a starved encoder), the 720p copy at its ~2.2 Mbps ceiling.
    const two = (t: number, hiBytes: number, loBytes: number, hiFrames: number, hiEnc: number, packets: number, delay: number) => report([
        { type: 'outbound-rtp', kind: 'video', rid: 'h', ssrc: 1, active: true, frameWidth: 3024, frameHeight: 1964, timestamp: t, bytesSent: hiBytes, framesEncoded: hiFrames, totalEncodeTime: hiEnc, packetsSent: packets, totalPacketSendDelay: delay, targetBitrate: 15_000_000 },
        { type: 'outbound-rtp', kind: 'video', rid: 'q', ssrc: 2, active: true, frameWidth: 1280, frameHeight: 720, timestamp: t, bytesSent: loBytes, framesEncoded: hiFrames / 2, totalEncodeTime: hiFrames * 0.003 / 2, packetsSent: 500, totalPacketSendDelay: 0.5 },
    ]);
    it('kbps sums both layers, top_kbps is the full layer alone, with its encode time, pacer wait and target', () => {
        const a = readShareNetSnapshot(two(0, 0, 0, 0, 0, 0, 0), 0)!;
        const b = readShareNetSnapshot(two(10_000, 1_000_000, 2_750_000, 550, 44, 1000, 5), 10_000)!;
        const d = buildShareNetDetail(a, b, { topLayer: true })!;
        expect(d.kbps).toBe(3000);                          // both layers: what share_net always said
        expect(d.top_kbps).toBe(800);                       // the full layer alone
        expect(d.top_enc_ms).toBeCloseTo(80, 0);            // 44 s / 550 frames - not diluted by the 3 ms copy
        expect(d.pace_ms).toBe(5);                          // 5 s of pacer delay over 1000 packets
        expect(d.tgt_kbps).toBe(15_000);
        expect(buildShareNetDetail(a, b, {})!.top_kbps).toBeUndefined(); // the report-time snapshot stays as it was
        expect(Object.keys(d).length).toBeLessThanOrEqual(11);
    });
});

describe('capKbpsFromEncodings', () => {
    it('sums the active encodings\' maxBitrate', () => {
        expect(capKbpsFromEncodings([{ maxBitrate: 12_000_000 }, { maxBitrate: 2_500_000, active: true }, { maxBitrate: 9e9, active: false }])).toBe(14_500);
    });
    it('undefined when nothing declares a ceiling', () => {
        expect(capKbpsFromEncodings([{}, { active: false, maxBitrate: 5 }])).toBeUndefined();
        expect(capKbpsFromEncodings(undefined)).toBeUndefined();
    });
});
