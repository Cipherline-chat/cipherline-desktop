import { describe, it, expect, vi } from 'vitest';
import { unifyOpusBundleParams, congestionControlSummary, installOpusBundleConsistency } from './sdpOpusBundleConsistency';

const audio = (mid: string, fmtp: string | null, port = 9) => [
    `m=audio ${port} UDP/TLS/RTP/SAVPF 111 63`,
    'c=IN IP4 0.0.0.0',
    `a=mid:${mid}`,
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    ...(fmtp === null ? [] : [`a=fmtp:111 ${fmtp}`]),
    'a=rtpmap:63 red/48000/2',
];
const sdp = (...secs: string[][]) => ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    `a=group:BUNDLE ${secs.map(s => s.find(l => l.startsWith('a=mid:'))!.slice(6)).join(' ')}`,
    ...secs.flat(), ''].join('\r\n');
const fmtpOf = (s: string, mid: string) => {
    const sec = s.split('m=').find(x => x.includes(`a=mid:${mid}\r\n`))!;
    return /a=fmtp:111 (.*)\r/.exec(sec)?.[1];
};

// The exact parameter sets from the Electron main log of the 2026-11-09 run.
const MIC = 'minptime=10;useinbandfec=1';
const SHARE_ANSWER = 'maxaveragebitrate=510000;minptime=10;stereo=1;useinbandfec=1';
const SHARE_OFFER = 'minptime=10;sprop-stereo=1;useinbandfec=1';

describe('unifyOpusBundleParams', () => {
    it('server answer: stereo+maxaveragebitrate on one section, plain on the other -> identical on both', () => {
        const r = unifyOpusBundleParams(sdp(audio('0', MIC), audio('1', SHARE_ANSWER)));
        expect(r.changed).toBe(true);
        expect(fmtpOf(r.sdp, '0')).toBe(fmtpOf(r.sdp, '1'));
        // stereo (screen-share audio) survives, nothing is dropped
        expect(fmtpOf(r.sdp, '1')).toContain('stereo=1');
        expect(fmtpOf(r.sdp, '1')).toContain('maxaveragebitrate=510000');
        expect(fmtpOf(r.sdp, '0')).toContain('useinbandfec=1');
    });

    it('server offer: sprop-stereo on one section only -> on all, so LiveKit answer munge stereos every mid', () => {
        const r = unifyOpusBundleParams(sdp(audio('0', MIC), audio('1', SHARE_OFFER), audio('2', MIC)));
        for (const m of ['0', '1', '2']) expect(fmtpOf(r.sdp, m)).toContain('sprop-stereo=1');
        expect(new Set(['0', '1', '2'].map(m => fmtpOf(r.sdp, m))).size).toBe(1);
    });

    it('a section with NO fmtp line gets one inserted next to its rtpmap', () => {
        const r = unifyOpusBundleParams(sdp(audio('0', null), audio('1', SHARE_ANSWER)));
        expect(fmtpOf(r.sdp, '0')).toBe(fmtpOf(r.sdp, '1'));
    });

    it('numeric conflicts keep the larger value', () => {
        const r = unifyOpusBundleParams(sdp(audio('0', 'maxaveragebitrate=64000;useinbandfec=1'), audio('1', 'maxaveragebitrate=192000;useinbandfec=1')));
        expect(fmtpOf(r.sdp, '0')).toContain('maxaveragebitrate=192000');
        expect(fmtpOf(r.sdp, '0')).not.toContain('64000');
    });

    it('already-consistent SDP is returned byte-identical', () => {
        const s = sdp(audio('0', MIC), audio('1', MIC));
        const r = unifyOpusBundleParams(s);
        expect(r.changed).toBe(false);
        expect(r.sdp).toBe(s);
    });

    it('leaves rejected (port 0) sections, non-bundled sections and a single section alone', () => {
        const rejected = sdp(audio('0', MIC), audio('1', SHARE_ANSWER, 0));
        expect(unifyOpusBundleParams(rejected).changed).toBe(false);
        expect(unifyOpusBundleParams(sdp(audio('0', SHARE_ANSWER))).changed).toBe(false);
        const noBundle = sdp(audio('0', MIC), audio('1', SHARE_ANSWER)).replace(/a=group:BUNDLE.*\r\n/, '');
        expect(unifyOpusBundleParams(noBundle).changed).toBe(false);
    });

    it('does not touch non-opus parameters (red line)', () => {
        const r = unifyOpusBundleParams(sdp(audio('0', MIC), audio('1', SHARE_ANSWER)));
        expect(r.sdp).toContain('a=rtpmap:63 red/48000/2');
        expect(r.sdp.split('\r\n').filter(l => l.startsWith('a=fmtp:63')).length).toBe(0);
    });

    it('preserves bare \\n line endings', () => {
        const s = sdp(audio('0', MIC), audio('1', SHARE_ANSWER)).replace(/\r\n/g, '\n');
        const r = unifyOpusBundleParams(s);
        expect(r.changed).toBe(true);
        expect(r.sdp.includes('\r')).toBe(false);
    });
});

describe('congestionControlSummary', () => {
    it('flags transport-cc vs goog-remb split across sections', () => {
        const video = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:2', 'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 goog-remb'];
        const r = congestionControlSummary(sdp(audio('0', MIC), video));
        expect(r.consistent).toBe(false);
        expect(r.summary).toContain('0:audio=transport-cc');
        expect(r.summary).toContain('2:video=goog-remb');
    });
    it('is consistent when all sections agree', () => {
        expect(congestionControlSummary(sdp(audio('0', MIC), audio('1', MIC))).consistent).toBe(true);
    });
});

describe('installOpusBundleConsistency', () => {
    it('wraps setRemoteDescription/setLocalDescription, is idempotent, and passes consistent SDP through', async () => {
        const seen: Array<RTCSessionDescriptionInit | undefined> = [];
        const proto = {
            setRemoteDescription: vi.fn(async (d?: RTCSessionDescriptionInit) => { seen.push(d); }),
            setLocalDescription: vi.fn(async (d?: RTCSessionDescriptionInit) => { seen.push(d); }),
        };
        expect(installOpusBundleConsistency(proto)).toBe(true);
        expect(installOpusBundleConsistency(proto)).toBe(false);
        await proto.setRemoteDescription({ type: 'answer', sdp: sdp(audio('0', MIC), audio('1', SHARE_ANSWER)) });
        expect(fmtpOf(seen[0]!.sdp!, '0')).toBe(fmtpOf(seen[0]!.sdp!, '1'));
        await proto.setLocalDescription(undefined);
        expect(seen[1]).toBeUndefined();
        const ok = { type: 'offer' as const, sdp: sdp(audio('0', MIC), audio('1', MIC)) };
        await proto.setRemoteDescription(ok);
        expect(seen[2]).toBe(ok);
    });
});
