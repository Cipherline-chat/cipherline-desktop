import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDecoderDead, RxDecoderLostWatch, shouldWithdrawH265, withdrawH265Decode } from './rxDecoderLost';
import {
    HEVC_ATTR, HEVC_RETRY_MS, HevcPolicy, __resetHevcForTests, hasHevcDecodeFailed, parseDecodeCaps, probeHevcDecode, roomHevcState,
} from './hevcNegotiation';
import { readShareRxSnapshot } from './shareRxStats';

beforeEach(() => __resetHevcForTests());

// The exact string from the owner's reports (truncated to 64 by readShareRxSnapshot).
const DEAD = 'NullVideoDecoder (fallback from: ExternalDecoder (D3D11VideoDeco';
const LIVE = 'ExternalDecoder (D3D11VideoDecoder)';

describe('isDecoderDead', () => {
    it('only the decoder that shows nothing', () => {
        expect(isDecoderDead(DEAD)).toBe(true);
        expect(isDecoderDead('NullVideoDecoder')).toBe(true);
        for (const d of [LIVE, 'libvpx', 'OpenH264', 'FFmpeg', '', undefined, null]) expect(isDecoderDead(d)).toBe(false);
    });

    it('reads it out of a real-shaped inbound-rtp report (decoder is cut to 64 chars)', () => {
        const report = { forEach: (cb: (s: Record<string, unknown>) => void) => {
            cb({ type: 'codec', id: 'C1', mimeType: 'video/H265' });
            cb({ type: 'inbound-rtp', kind: 'video', codecId: 'C1', framesReceived: 900, framesDecoded: 12, framesDropped: 880,
                decoderImplementation: 'NullVideoDecoder (fallback from: ExternalDecoder (D3D11VideoDecoder))', powerEfficientDecoder: false });
        } };
        const snap = readShareRxSnapshot(report, 1);
        expect(snap?.codec).toBe('h265');
        expect(isDecoderDead(snap?.decoder)).toBe(true);
    });
});

describe('RxDecoderLostWatch', () => {
    const elA = {}; const elB = {};

    it('fires once per death, not on every tick', () => {
        const w = new RxDecoderLostWatch();
        expect(w.observe(0, { decoder: LIVE, codec: 'h265' }, { tile: 696, playbackKey: elA })).toBeNull();
        expect(w.observe(2000, { decoder: DEAD, codec: 'h265' }, { tile: 696, playbackKey: elA })).toEqual({ codec: 'h265', tile: 696, el_ms: -1 });
        expect(w.observe(4000, { decoder: DEAD, codec: 'h265' }, { tile: 696, playbackKey: elA })).toBeNull();
        expect(w.observe(6000, { decoder: DEAD, codec: 'h265' }, { tile: 696, playbackKey: elA })).toBeNull();
    });

    it('fires again after a decoder that recovered dies a second time', () => {
        const w = new RxDecoderLostWatch();
        expect(w.observe(0, { decoder: DEAD, codec: 'h265' }, { playbackKey: elA })).not.toBeNull();
        expect(w.observe(2000, { decoder: LIVE, codec: 'h265' }, { playbackKey: elA })).toBeNull();
        expect(w.observe(4000, { decoder: DEAD, codec: 'h265' }, { playbackKey: elA })).not.toBeNull();
    });

    it('says how long ago the displayed element changed - the thing the reports could not tell', () => {
        const w = new RxDecoderLostWatch();
        w.observe(0, { decoder: LIVE, codec: 'h265' }, { tile: 1080, playbackKey: elA });
        w.observe(2000, { decoder: LIVE, codec: 'h265' }, { tile: 1080, playbackKey: elA });
        // Fullscreen closed: the share moved to the docked view's element.
        w.observe(4000, { decoder: LIVE, codec: 'h265' }, { tile: 696, playbackKey: elB });
        const lost = w.observe(6000, { decoder: DEAD, codec: 'h265' }, { tile: 696, playbackKey: elB });
        expect(lost).toEqual({ codec: 'h265', tile: 696, el_ms: 2000 });
    });

    it('a video with no element yet (null key) neither counts as a change nor loses the last one', () => {
        const w = new RxDecoderLostWatch();
        w.observe(0, { decoder: LIVE }, { playbackKey: elA });
        w.observe(2000, { decoder: LIVE }, { playbackKey: null });
        const lost = w.observe(4000, { decoder: DEAD }, { playbackKey: elA });
        expect(lost?.el_ms).toBe(-1);
    });

    it('no stats yet: nothing', () => {
        expect(new RxDecoderLostWatch().observe(0, null, { playbackKey: elA })).toBeNull();
    });
});

describe('withdrawing H.265 decode', () => {
    const room = () => {
        const calls: Record<string, string>[] = [];
        return { calls, room: { localParticipant: { setAttributes: vi.fn(async (a: Record<string, string>) => { calls.push(a); }) } } };
    };

    it('H.265 (or an unknown codec on the nothing-decoder): advertise "no H.265" and latch it', () => {
        for (const codec of ['h265', undefined]) {
            __resetHevcForTests();
            const r = room();
            expect(shouldWithdrawH265({ codec, el_ms: -1 })).toBe(true);
            expect(withdrawH265Decode(r.room, { codec, el_ms: -1 })).toBe(true);
            expect(r.calls).toEqual([{ [HEVC_ATTR]: '1:' }]);
            expect(hasHevcDecodeFailed()).toBe(true);
        }
    });

    it('any other codec is left alone (they fall back to software; this state is not theirs)', () => {
        const r = room();
        expect(withdrawH265Decode(r.room, { codec: 'h264', el_ms: -1 })).toBe(false);
        expect(r.calls).toEqual([]);
        expect(hasHevcDecodeFailed()).toBe(false);
    });

    it('a room that is closing does not throw', () => {
        const closing = { localParticipant: { setAttributes: () => Promise.reject(new Error('closed')) } };
        expect(() => withdrawH265Decode(closing, { codec: 'h265', el_ms: 0 })).not.toThrow();
    });

    it('the latch ends after HEVC_RETRY_MS, and until then the decode probe says no even though the browser lists H.265', async () => {
        const deps = { receiverCaps: () => ({ codecs: [{ mimeType: 'video/H265' }] }), decodingInfo: async () => ({ supported: true, powerEfficient: true }) };
        expect(await probeHevcDecode(deps)).toBe(true);
        withdrawH265Decode(room().room, { codec: 'h265', el_ms: 0 }, 1_000);
        expect(hasHevcDecodeFailed(1_000 + HEVC_RETRY_MS - 1)).toBe(true);
        expect(hasHevcDecodeFailed(1_000 + HEVC_RETRY_MS)).toBe(false);
        withdrawH265Decode(room().room, { codec: 'h265', el_ms: 0 });
        expect(await probeHevcDecode(deps)).toBe(false);
    });

    it('what a publisher then does: the withdrawn attribute is "someone cannot decode", so its policy goes to base at once', () => {
        const attr = '1:';
        expect(parseDecodeCaps(attr)).toEqual({ h265: false });
        const state = roomHevcState([{ attr, joinedMsAgo: 60_000 }]);
        expect(state).toBe('incapable');
        const policy = new HevcPolicy('h265');
        expect(policy.observe(state, true, 100_000)).toBe('base');
    });
});

describe('wired into the call monitor', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/call/CallEventMonitor.tsx'), 'utf8');

    it('every remote video (camera and share) is watched, and a loss logs and withdraws', () => {
        expect(src).toContain("from '../../utils/rxDecoderLost'");
        expect(src).toMatch(/\.lost\.observe\(now, rxs, \{ tile: info\.tile, playbackKey: info\.playbackKey \}\)/);
        expect(src).toContain('withdrawH265Decode(room, lost)');
        expect(src).toContain("logCallEvent('rx_decoder_lost'");
        // Before the share-only block, so the camera is covered too.
        expect(src.indexOf("logCallEvent('rx_decoder_lost'")).toBeLessThan(src.indexOf('if (source === Track.Source.ScreenShare) {\n                            let w = watches'));
    });
});
