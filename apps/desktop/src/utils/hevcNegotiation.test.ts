import { describe, it, expect } from 'vitest';
import {
    formatDecodeCaps, parseDecodeCaps, roomHevcState, hevcCapableCount, HevcPolicy, probeHevcDecode, probeHevcEncode,
    HEVC_ATTR, HEVC_JOIN_GRACE_MS, HEVC_UP_MS, HEVC_MIN_GAP_MS,
} from './hevcNegotiation';

describe('capability advertisement format', () => {
    it('attribute key and values', () => {
        expect(HEVC_ATTR).toBe('cl.vdec');
        expect(formatDecodeCaps({ h265: true })).toBe('1:h265');
        expect(formatDecodeCaps({ h265: false })).toBe('1:');
    });
    it.each([
        ['1:h265', { h265: true }],
        ['1:', { h265: false }],
        ['1:av1,h265', { h265: true }],   // a future list still parses
        ['1:vp9', { h265: false }],
        ['2:h265', null],                  // unknown version → not capable
        ['h265', null],
        ['1:H265', null],                  // strict lower-case format
        ['', null],
        [undefined, null],
        [null, null],
        ['1:' + 'x'.repeat(80), null],    // oversize
    ] as const)('parseDecodeCaps(%j) → %j', (raw, want) => {
        expect(parseDecodeCaps(raw as string | undefined | null)).toEqual(want);
    });
    it('round-trips', () => {
        for (const h265 of [true, false]) expect(parseDecodeCaps(formatDecodeCaps({ h265 }))).toEqual({ h265 });
    });
});

describe('roomHevcState', () => {
    const cap = (joinedMsAgo = 60_000) => ({ attr: '1:h265', joinedMsAgo });
    const noCap = (joinedMsAgo = 60_000) => ({ attr: '1:', joinedMsAgo });
    const silent = (joinedMsAgo = 60_000) => ({ joinedMsAgo }); // mobile / older desktop: never advertises
    it('alone', () => expect(roomHevcState([])).toBe('alone'));
    it('all capable', () => expect(roomHevcState([cap(), cap()])).toBe('all'));
    it('one says it cannot', () => expect(roomHevcState([cap(), noCap()])).toBe('incapable'));
    it('one never advertised (Android app) → incapable after the grace', () => {
        expect(roomHevcState([cap(), silent(HEVC_JOIN_GRACE_MS - 1)])).toBe('pending');
        expect(roomHevcState([cap(), silent(HEVC_JOIN_GRACE_MS)])).toBe('incapable');
    });
    it('an explicit "cannot" is never pending', () => expect(roomHevcState([noCap(10)])).toBe('incapable'));
    it('counts', () => expect(hevcCapableCount([cap(), noCap(), silent()])).toEqual({ capable: 1, total: 3 }));
});

describe('HevcPolicy — negotiation with hysteresis', () => {
    it('all capable → H.265 only after HEVC_UP_MS of everyone qualifying', () => {
        const p = new HevcPolicy('base');
        expect(p.observe('all', true, 0)).toBeNull();
        expect(p.observe('all', true, HEVC_UP_MS - 1)).toBeNull();
        expect(p.observe('all', true, HEVC_UP_MS)).toBe('h265');
    });

    it('someone who cannot decode joins → back to base IMMEDIATELY (no hold, no min gap)', () => {
        const p = new HevcPolicy('base');
        p.observe('all', true, 0);
        expect(p.observe('all', true, HEVC_UP_MS)).toBe('h265');
        p.applied('h265', HEVC_UP_MS);
        expect(p.observe('incapable', true, HEVC_UP_MS + 1)).toBe('base');
    });

    it('they leave → H.265 again only after another HEVC_UP_MS (and the min gap)', () => {
        const p = new HevcPolicy('h265');
        p.applied('h265', 0);
        expect(p.observe('incapable', true, 1000)).toBe('base');
        p.applied('base', 1000);
        expect(p.observe('all', true, 2000)).toBeNull();                 // starts the clock
        expect(p.observe('all', true, 2000 + HEVC_UP_MS - 1)).toBeNull();
        expect(p.observe('all', true, 2000 + HEVC_UP_MS)).toBe('h265');
    });

    it('no oscillation: someone briefly joining and leaving inside the window restarts the clock', () => {
        const p = new HevcPolicy('base');
        p.observe('all', true, 0);
        p.observe('incapable', true, 10_000);   // joined
        p.observe('all', true, 12_000);         // left
        expect(p.observe('all', true, HEVC_UP_MS + 1)).toBeNull();
        expect(p.observe('all', true, 12_000 + HEVC_UP_MS)).toBe('h265');
    });

    it('a pending participant (attribute not arrived yet) neither switches down nor resets the clock', () => {
        const up = new HevcPolicy('h265');
        expect(up.observe('pending', true, 100)).toBeNull();
        const down = new HevcPolicy('base');
        down.observe('all', true, 0);
        down.observe('pending', true, 1000);
        expect(down.observe('all', true, HEVC_UP_MS)).toBe('h265');
    });

    it('the min gap bounds switching', () => {
        const p = new HevcPolicy('base');
        p.applied('base', 0);
        p.observe('all', true, 0);
        p.applied('h265', HEVC_UP_MS);
        p.applied('base', HEVC_UP_MS + 1);
        p.observe('all', true, HEVC_UP_MS + 2);
        expect(p.observe('all', true, HEVC_UP_MS + 1 + Math.min(HEVC_MIN_GAP_MS, HEVC_UP_MS) - 1)).toBeNull();
    });

    it('not allowed (setting off, no HW encoder, failed this session) → base, never H.265', () => {
        const p = new HevcPolicy('h265');
        expect(p.observe('all', false, 0)).toBe('base');
        p.applied('base', 0);
        expect(p.observe('all', false, 10 * HEVC_UP_MS)).toBeNull();
    });

    it('alone → base (nobody to save bandwidth for; avoids an immediate switch when an incapable joiner arrives)', () => {
        const p = new HevcPolicy('h265');
        expect(p.observe('alone', true, 0)).toBe('base');
    });
});

describe('probes', () => {
    const caps = (...mimes: string[]) => () => ({ codecs: mimes.map(mimeType => ({ mimeType })) });
    it('decode: needs H.265 in receiver capabilities AND decodingInfo supported', async () => {
        expect(await probeHevcDecode({ receiverCaps: caps('video/VP8', 'video/H265'), decodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(true);
        expect(await probeHevcDecode({ receiverCaps: caps('video/VP8'), decodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(false);
        expect(await probeHevcDecode({ receiverCaps: caps('video/H265'), decodingInfo: async () => ({ supported: false, powerEfficient: false }) })).toBe(false);
        expect(await probeHevcDecode({ receiverCaps: () => { throw new Error('x'); } })).toBe(false);
    });
    it('encode: needs H.265 in sender capabilities AND a power-efficient (hardware) encoder', async () => {
        expect(await probeHevcEncode({ senderCaps: caps('video/H265'), encodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(true);
        expect(await probeHevcEncode({ senderCaps: caps('video/H265'), encodingInfo: async () => ({ supported: true, powerEfficient: false }) })).toBe(false);
        expect(await probeHevcEncode({ senderCaps: caps('video/H264'), encodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(false);
        expect(await probeHevcEncode({ senderCaps: caps('video/H265') })).toBe(false); // no MediaCapabilities = unknown = no
    });
});
