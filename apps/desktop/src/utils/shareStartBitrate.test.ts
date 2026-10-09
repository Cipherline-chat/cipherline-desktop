import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    shareStartKbps, withVideoStartBitrate, availableOutgoingBps, installShareStartBitrate,
    SHARE_START_CAP_KBPS, type PublisherTransportLike, type StartBitrateParticipant,
} from './shareStartBitrate';

// Trimmed from a real LiveKit v1.9.12 publisher answer (harness, livekit-client
// 2.18.8 single-PC mode): a downstream video section (mid 3, sendonly from the
// SFU) and the screen share's upstream section (mid 8). ICE/DTLS lines dropped.
const SHARE_SECTION = [
    'm=video 9 UDP/TLS/RTP/SAVPF 109 115 96 45 98 35 99 46 116 114 97 36',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:109 H264/90000',
    'a=rtpmap:115 H264/90000',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:45 AV1/90000',
    'a=rtpmap:98 VP9/90000',
    'a=rtpmap:35 VP9/90000',
    'a=rtpmap:99 rtx/90000',
    'a=rtpmap:46 rtx/90000',
    'a=rtpmap:116 rtx/90000',
    'a=rtpmap:114 rtx/90000',
    'a=rtpmap:97 rtx/90000',
    'a=rtpmap:36 rtx/90000',
    'a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=fmtp:115 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
    'a=fmtp:45 level-idx=5;profile=0;tier=0',
    'a=fmtp:98 profile-id=0',
    'a=fmtp:35 profile-id=2',
    'a=fmtp:99 apt=98',
    'a=fmtp:46 apt=45',
    'a=fmtp:116 apt=115',
    'a=fmtp:114 apt=109',
    'a=fmtp:97 apt=96',
    'a=fmtp:36 apt=35',
    'a=rtcp-fb:109 transport-cc',
    'a=setup:active',
    'a=mid:8',
    'a=recvonly',
    'a=rtcp-mux',
];
const DOWN_SECTION = [
    'm=video 9 UDP/TLS/RTP/SAVPF 96 98 109 97',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:98 VP9/90000',
    'a=rtpmap:109 H264/90000',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:98 profile-id=0',
    'a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=fmtp:97 apt=96',
    'a=mid:3',
    'a=sendonly',
];
const AUDIO_SECTION = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=mid:0', 'a=sendonly'];
const HEAD = ['v=0', 'o=- 1 2 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0 3 8'];
const ANSWER = [...HEAD, ...AUDIO_SECTION, ...DOWN_SECTION, ...SHARE_SECTION, ''].join('\r\n');

describe('shareStartKbps', () => {
    it('starts at half the share ceiling, capped', () => {
        expect(shareStartKbps(9_000_000, null)).toBe(4_500);          // 1080p30 H.264
        expect(shareStartKbps(2_500_000, null)).toBe(1_250);          // 720p30 VP8
        expect(shareStartKbps(54_000_000, null)).toBe(SHARE_START_CAP_KBPS); // source 60 H.264
    });
    it('never lowers an estimate that is already at or above the target', () => {
        expect(shareStartKbps(36_000_000, 8_000_000)).toBeNull();
        expect(shareStartKbps(36_000_000, 12_000_000)).toBeNull();
        expect(shareStartKbps(36_000_000, 7_999_000)).toBe(8_000);
    });
    it('control: the low estimate a mic-only connection reports is raised', () => {
        expect(shareStartKbps(36_000_000, 352_000)).toBe(8_000);
    });
    it('rejects nonsense ceilings', () => {
        for (const bad of [0, -1, NaN, Infinity]) expect(shareStartKbps(bad, null)).toBeNull();
    });
});

describe('withVideoStartBitrate', () => {
    const lines = (sdp: string) => sdp.split('\r\n');

    it('adds the start bitrate to every primary codec of the share section, and only there', () => {
        const r = withVideoStartBitrate(ANSWER, '8', 8000);
        expect(r.result).toBe('applied');
        const out = lines(r.sdp);
        expect(out).toContain('a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=8000');
        expect(out).toContain('a=fmtp:115 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f;x-google-start-bitrate=8000');
        expect(out).toContain('a=fmtp:45 level-idx=5;profile=0;tier=0;x-google-start-bitrate=8000');
        // VP8 has no fmtp line: one is created right after its rtpmap.
        const vp8 = out.indexOf('a=rtpmap:96 VP8/90000', out.indexOf('a=mid:3') + 1);
        expect(out[vp8 + 1]).toBe('a=fmtp:96 x-google-start-bitrate=8000');
        // rtx lines and everything outside the section are untouched.
        for (const l of out) if (/apt=/.test(l)) expect(l).not.toContain('x-google');
        const before = lines(ANSWER);
        const shareStart = before.indexOf(SHARE_SECTION[0]);
        expect(out.slice(0, shareStart)).toEqual(before.slice(0, shareStart));
        expect(out.length).toBe(before.length + 1);
    });
    it('control: the unmunged answer carries no start bitrate at all', () => {
        expect(ANSWER).not.toContain('x-google-start-bitrate');
    });
    it('is idempotent — a section that already has one is left alone', () => {
        const once = withVideoStartBitrate(ANSWER, '8', 8000).sdp;
        const twice = withVideoStartBitrate(once, '8', 4000);
        expect(twice.result).toBe('present');
        expect(twice.sdp).toBe(once);
    });
    it('leaves a VP9 send section to LiveKit\'s own rule', () => {
        const vp9First = ANSWER.replace(SHARE_SECTION[0], 'm=video 9 UDP/TLS/RTP/SAVPF 98 109 115 96 45 35 99 46 116 114 97 36');
        const r = withVideoStartBitrate(vp9First, '8', 8000);
        expect(r).toEqual({ sdp: vp9First, result: 'vp9' });
    });
    it('does nothing for an unknown mid or a non-video mid', () => {
        expect(withVideoStartBitrate(ANSWER, '42', 8000)).toEqual({ sdp: ANSWER, result: 'no-section' });
        expect(withVideoStartBitrate(ANSWER, '0', 8000)).toEqual({ sdp: ANSWER, result: 'no-section' });
    });
    it('keeps LF-only line endings', () => {
        const lf = ANSWER.replace(/\r\n/g, '\n');
        const r = withVideoStartBitrate(lf, '8', 2000);
        expect(r.result).toBe('applied');
        expect(r.sdp).not.toContain('\r');
        expect(r.sdp).toContain('a=fmtp:96 x-google-start-bitrate=2000\n');
    });
});

describe('availableOutgoingBps', () => {
    it('reads the selected candidate pair', () => {
        const stats = new Map<string, unknown>([
            ['T', { type: 'transport', selectedCandidatePairId: 'P2' }],
            ['P1', { type: 'candidate-pair', id: 'P1', nominated: true, availableOutgoingBitrate: 100 }],
            ['P2', { type: 'candidate-pair', id: 'P2', availableOutgoingBitrate: 352_000 }],
        ]);
        expect(availableOutgoingBps(stats)).toBe(352_000);
    });
    it('falls back to the nominated pair, and to null', () => {
        expect(availableOutgoingBps([{ type: 'candidate-pair', id: 'P', nominated: true, availableOutgoingBitrate: 5 }])).toBe(5);
        expect(availableOutgoingBps([{ type: 'candidate-pair', id: 'P', nominated: false }])).toBeNull();
    });
});

// ── installShareStartBitrate against a fake LiveKit participant/transport ────

function fakes(estimateBps: number | null = 352_000) {
    const shareSender = { id: 'share' } as unknown as RTCRtpSender;
    const camSender = { id: 'cam' } as unknown as RTCRtpSender;
    const applied: string[] = [];
    const offerIds: number[] = [];
    const transport: PublisherTransportLike = {
        async setRemoteDescription(sd, offerId) { applied.push(sd.sdp ?? ''); offerIds.push(offerId); return true; },
        getTransceivers: () => [
            { sender: camSender, mid: '3' } as unknown as RTCRtpTransceiver,
            { sender: shareSender, mid: '8' } as unknown as RTCRtpTransceiver,
        ],
        getStats: async () => new Map<string, unknown>(estimateBps === null ? [] : [
            ['P', { type: 'candidate-pair', id: 'P', nominated: true, availableOutgoingBitrate: estimateBps }],
        ]) as unknown as RTCStatsReport,
    };
    const listeners: Array<(s: RTCRtpSender, t: { source?: string }) => void> = [];
    const participant: StartBitrateParticipant = {
        engine: { pcManager: { publisher: transport } },
        on: (_e, cb) => { listeners.push(cb); },
        off: (_e, cb) => { listeners.splice(listeners.indexOf(cb), 1); },
    };
    const emit = (s: RTCRtpSender, source: string) => listeners.forEach(l => l(s, { source }));
    return { participant, transport, applied, offerIds, emit, shareSender, camSender, listeners };
}
const answer = (): RTCSessionDescriptionInit => ({ type: 'answer', sdp: ANSWER });

describe('installShareStartBitrate', () => {
    it('munges the answer that follows a screen-share sender, once', async () => {
        const f = fakes();
        const log = vi.fn();
        installShareStartBitrate(f.participant, () => 36_000_000, log);
        f.emit(f.shareSender, 'screen_share');
        await f.transport.setRemoteDescription(answer(), 7);
        await f.transport.setRemoteDescription(answer(), 8);
        expect(f.applied[0]).toContain('a=fmtp:96 x-google-start-bitrate=8000');
        expect(f.applied[1]).toBe(ANSWER);           // later renegotiations untouched
        expect(f.offerIds).toEqual([7, 8]);          // offerId passed through
        expect(log).toHaveBeenCalledWith(expect.stringContaining('start bitrate 8000 kbps (estimate was 352 kbps)'));
    });
    it('control: a camera sender arms nothing', async () => {
        const f = fakes();
        installShareStartBitrate(f.participant, () => 36_000_000, () => {});
        f.emit(f.camSender, 'camera');
        await f.transport.setRemoteDescription(answer(), 1);
        expect(f.applied[0]).toBe(ANSWER);
    });
    it('does not lower an estimate that is already high', async () => {
        const f = fakes(20_000_000);
        installShareStartBitrate(f.participant, () => 36_000_000, () => {});
        f.emit(f.shareSender, 'screen_share');
        await f.transport.setRemoteDescription(answer(), 1);
        expect(f.applied[0]).toBe(ANSWER);
    });
    it('a stats read that never answers does not hold the negotiation (treated as unknown)', async () => {
        const f = fakes();
        f.transport.getStats = () => new Promise<RTCStatsReport>(() => {});
        installShareStartBitrate(f.participant, () => 36_000_000, () => {});
        f.emit(f.shareSender, 'screen_share');
        const t0 = Date.now();
        await f.transport.setRemoteDescription(answer(), 1);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(f.applied[0]).toContain('x-google-start-bitrate=8000');
    });
    it('does nothing while no share ceiling is known', async () => {
        const f = fakes();
        installShareStartBitrate(f.participant, () => null, () => {});
        f.emit(f.shareSender, 'screen_share');
        await f.transport.setRemoteDescription(answer(), 1);
        expect(f.applied[0]).toBe(ANSWER);
    });
    it('a stale arm (publish never answered) expires', async () => {
        const f = fakes();
        let t = 0;
        installShareStartBitrate(f.participant, () => 36_000_000, () => {}, () => t);
        f.emit(f.shareSender, 'screen_share');
        t = 60_000;
        await f.transport.setRemoteDescription(answer(), 1);
        expect(f.applied[0]).toBe(ANSWER);
    });
    it('never breaks the negotiation if the lookup throws', async () => {
        const f = fakes();
        installShareStartBitrate(f.participant, () => 36_000_000, () => {});
        f.transport.getTransceivers = () => { throw new Error('closed'); };
        f.emit(f.shareSender, 'screen_share');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(f.transport.setRemoteDescription(answer(), 1)).resolves.toBe(true);
        expect(f.applied[0]).toBe(ANSWER);
        warn.mockRestore();
    });
    it('unsubscribes', () => {
        const f = fakes();
        const off = installShareStartBitrate(f.participant, () => 1, () => {});
        expect(f.listeners).toHaveLength(1);
        off();
        expect(f.listeners).toHaveLength(0);
    });
});

// ── livekit-client 2.18.8 facts this relies on (fails loudly on an upgrade) ──

function livekitSrc(rel: string): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'src', rel);
        if (existsSync(p)) return readFileSync(p, 'utf8');
        dir = dirname(dir);
    }
    throw new Error(`livekit-client source not found: ${rel}`);
}

describe('livekit-client facts', () => {
    const pct = livekitSrc('room/PCTransport.ts');
    const lp = livekitSrc('room/participant/LocalParticipant.ts');
    it('its own start-bitrate munge is VP9/AV1 (SVC) only — the gap this module fills', () => {
        expect(pct).toMatch(/if \(!isSVCCodec\(trackbr\.codec\)\) \{\s*return true;\s*\}/);
        expect(pct).toContain('x-google-start-bitrate');
    });
    it('answers reach the connection through PCTransport.setRemoteDescription(sd, offerId)', () => {
        expect(pct).toMatch(/async setRemoteDescription\(sd: RTCSessionDescriptionInit, offerId: number\): Promise<boolean>/);
    });
    it('localSenderCreated fires synchronously before the negotiation that carries the new sender', () => {
        const i = lp.indexOf('this.emit(ParticipantEvent.LocalSenderCreated, track.sender, track);');
        const j = lp.indexOf('await this.engine.negotiate();', i);
        expect(i).toBeGreaterThan(0);
        expect(j).toBeGreaterThan(i);
    });
});
