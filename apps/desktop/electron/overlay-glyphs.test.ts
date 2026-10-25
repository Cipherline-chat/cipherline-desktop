import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import {
    resolveOverlay, flattenPath, rasterizeOverlay, buildOverlayPng,
    MENTION_DESCRIPTION, DEAFENED_DESCRIPTION, MUTED_DESCRIPTION,
    OVERLAY_SIZE, UNREAD_SIZE, type OverlayInputs, type OverlayKind,
} from './overlay-glyphs';

const bools = [false, true];

describe('resolveOverlay — priority mention > deafened > muted > unread > none', () => {
    // Exhaustive: 2^4 booleans x unread {0, 7}.
    for (const inCall of bools) for (const isDeafened of bools) for (const isMuted of bools)
        for (const hasMention of bools) for (const unreadCount of [0, 7]) {
            const s: OverlayInputs = { inCall, isDeafened, isMuted, hasMention, unreadCount };
            const expected: OverlayKind =
                hasMention ? 'mention'
                : inCall && isDeafened ? 'deafened'
                : inCall && isMuted ? 'muted'
                : unreadCount > 0 ? 'unread'
                : 'none';
            it(`${JSON.stringify(s)} -> ${expected}`, () => {
                expect(resolveOverlay(s).kind).toBe(expected);
            });
        }

    it('mute/deafen only count while IN a call', () => {
        const base = { hasMention: false, unreadCount: 0 };
        expect(resolveOverlay({ ...base, inCall: false, isDeafened: true, isMuted: true }).kind).toBe('none');
    });

    it('deafened beats muted (deafening usually implies muting)', () => {
        expect(resolveOverlay({ inCall: true, isDeafened: true, isMuted: true, hasMention: false, unreadCount: 0 }).kind).toBe('deafened');
    });

    it('an unread count does not hide a call state, but a mention does', () => {
        expect(resolveOverlay({ inCall: true, isDeafened: false, isMuted: true, hasMention: false, unreadCount: 9 }).kind).toBe('muted');
        expect(resolveOverlay({ inCall: true, isDeafened: false, isMuted: true, hasMention: true, unreadCount: 9 }).kind).toBe('mention');
    });

    it('accessible descriptions', () => {
        const none = { inCall: false, isDeafened: false, isMuted: false, hasMention: false, unreadCount: 0 };
        expect(resolveOverlay({ ...none, hasMention: true }).description).toBe('You were mentioned');
        expect(resolveOverlay({ ...none, inCall: true, isDeafened: true }).description).toBe('Deafened');
        expect(resolveOverlay({ ...none, inCall: true, isMuted: true }).description).toBe('Muted');
        expect(resolveOverlay({ ...none, unreadCount: 3 }).description).toBe('3 unread');
        expect(resolveOverlay(none).description).toBe('');
        expect([MENTION_DESCRIPTION, DEAFENED_DESCRIPTION, MUTED_DESCRIPTION]).toEqual(['You were mentioned', 'Deafened', 'Muted']);
    });
});

describe('flattenPath', () => {
    it('handles relative/absolute lines and implicit lineto', () => {
        expect(flattenPath('M1 2 l3 4 h1 v-2')).toEqual([[[1, 2], [4, 6], [5, 6], [5, 4]]]);
        expect(flattenPath('m2 2 20 20')).toEqual([[[2, 2], [22, 22]]]);
    });

    it('a half-circle arc lands on its endpoint and bulges to the radius', () => {
        const [poly] = flattenPath('M0 0 a5 5 0 0 1 10 0');
        expect(poly[poly.length - 1]).toEqual([10, 0]);
        const minY = Math.min(...poly.map(p => p[1]));
        expect(minY).toBeCloseTo(-5, 1);                 // sweep=1 from left to right bows upward (-y)
    });

    it('lucide path data stays inside the 24-unit box', () => {
        for (const d of ['M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8', 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364']) {
            for (const poly of flattenPath(d)) for (const [x, y] of poly) {
                expect(x).toBeGreaterThan(-0.5); expect(x).toBeLessThan(24.5);
                expect(y).toBeGreaterThan(-0.5); expect(y).toBeLessThan(24.5);
            }
        }
    });

    it('rejects an unsupported command instead of silently drawing nothing', () => {
        expect(() => flattenPath('M0 0 Q1 1 2 2')).toThrow(/unsupported/);
    });
});

function alphaAt(px: Uint8Array, size: number, x: number, y: number): number { return px[(y * size + x) * 4 + 3]; }
function rgbAt(px: Uint8Array, size: number, x: number, y: number): [number, number, number] {
    const o = (y * size + x) * 4; return [px[o], px[o + 1], px[o + 2]];
}

describe('rasterised glyphs', () => {
    for (const size of [16, 32]) {
        for (const kind of ['mention', 'deafened', 'muted'] as const) {
            it(`${kind} @${size}px: transparent corners, opaque disc, glyph ink present`, () => {
                const px = rasterizeOverlay(kind, size);
                expect(px.length).toBe(size * size * 4);
                expect(alphaAt(px, size, 0, 0)).toBe(0);
                expect(alphaAt(px, size, size - 1, size - 1)).toBe(0);
                // Just inside the rim, on the horizontal axis: fully opaque.
                expect(alphaAt(px, size, 2, size / 2)).toBe(255);
                // Some pixels differ clearly from the backdrop (the glyph).
                const bg = rgbAt(px, size, 2, size / 2);
                let ink = 0;
                for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                    if (alphaAt(px, size, x, y) !== 255) continue;
                    const c = rgbAt(px, size, x, y);
                    if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 150) ink++;
                }
                expect(ink).toBeGreaterThan(size * 0.6);
            });
        }
    }

    it('the three glyphs are visibly different images', () => {
        const a = Buffer.from(rasterizeOverlay('mention', 32));
        const b = Buffer.from(rasterizeOverlay('deafened', 32));
        const c = Buffer.from(rasterizeOverlay('muted', 32));
        expect(a.equals(b)).toBe(false);
        expect(b.equals(c)).toBe(false);
        expect(a.equals(c)).toBe(false);
    });

    it('mention uses the coral mention colour, mute/deafen the red', () => {
        expect(rgbAt(rasterizeOverlay('mention', 32), 32, 2, 16)).toEqual([0xFF, 0x6B, 0x5E]);
        expect(rgbAt(rasterizeOverlay('muted', 32), 32, 2, 16)).toEqual([0xDC, 0x26, 0x26]);
        expect(rgbAt(rasterizeOverlay('deafened', 32), 32, 2, 16)).toEqual([0xDC, 0x26, 0x26]);
    });

    it('the unread dot is unchanged: #F04747 disc, 20px', () => {
        const px = rasterizeOverlay('unread', UNREAD_SIZE);
        expect(rgbAt(px, UNREAD_SIZE, 10, 10)).toEqual([240, 71, 71]);
        expect(alphaAt(px, UNREAD_SIZE, 10, 10)).toBe(255);
        expect(alphaAt(px, UNREAD_SIZE, 0, 0)).toBe(0);
    });
});

describe('buildOverlayPng', () => {
    it('emits a valid RGBA PNG at the production size', () => {
        for (const [kind, size] of [['mention', OVERLAY_SIZE], ['deafened', OVERLAY_SIZE], ['muted', OVERLAY_SIZE], ['unread', UNREAD_SIZE]] as const) {
            const png = buildOverlayPng(kind);
            expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            expect(png.readUInt32BE(16)).toBe(size);          // IHDR width
            expect(png.readUInt32BE(20)).toBe(size);          // IHDR height
            expect(png[24]).toBe(8); expect(png[25]).toBe(6); // 8-bit RGBA
            // Round-trip: inflate the IDAT and compare with the raster.
            const idatLen = png.readUInt32BE(33);
            const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
            const px = rasterizeOverlay(kind, size);
            expect(raw.length).toBe((size * 4 + 1) * size);
            for (let y = 0; y < size; y++) {
                expect(raw[y * (size * 4 + 1)]).toBe(0);
                expect(Buffer.from(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)))
                    .equals(Buffer.from(px.subarray(y * size * 4, (y + 1) * size * 4)))).toBe(true);
            }
        }
    });
});
