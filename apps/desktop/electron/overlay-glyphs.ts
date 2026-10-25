/**
 * overlay-glyphs.ts — what the Windows taskbar overlay shows, and the pixels
 * for it. PURE: no `electron` import, so it is unit-testable under vitest and
 * (per the electron rootDir rule) imports nothing from src/.
 *
 * ONE state glyph at a time, highest priority first:
 *
 *   mention  > deafened > muted > unread > none
 *
 *   mention   "@"                      coral  (the mention-pill colour, --flash)
 *   deafened  headphones with a slash  red    (matches the red MicOff/HeadphoneOff
 *   muted     mic with a slash         red     icons the call UI draws)
 *   unread    plain red dot            (unchanged from before; carries the count
 *                                       in its accessible description)
 *
 * deafened / muted only apply while IN a call, exactly as before. An unread
 * @mention outranks everything, including being deafened: it is the thing the
 * user can act on, and the call state is already visible inside the app.
 *
 * The three glyph shapes are the lucide-react `AtSign`, `HeadphoneOff` and
 * `MicOff` icons the app already uses (path data copied from lucide-react
 * 0.577, ISC), so the taskbar reads as the same symbols as the call controls.
 * They are rasterised here, in plain Node, because the main-process image
 * decoder cannot read SVG on Windows (see badge.ts history): the paths are
 * flattened to polylines and drawn as round-capped strokes with 4x4
 * supersampling, then PNG-encoded with zlib.
 */

import * as zlib from 'zlib';

// ── State selection ──────────────────────────────────────────────────────────

export type OverlayKind = 'mention' | 'deafened' | 'muted' | 'unread' | 'none';

export interface OverlayInputs {
    inCall: boolean;
    isDeafened: boolean;
    isMuted: boolean;
    /** Any unread @mention, in a DM/group or a server channel. */
    hasMention: boolean;
    /** The OS badge total (already filtered by the user's badge prefs). */
    unreadCount: number;
}

export interface OverlayChoice {
    kind: OverlayKind;
    /** Accessible description handed to setOverlayIcon ('' for none). */
    description: string;
}

export const MENTION_DESCRIPTION = 'You were mentioned';
export const DEAFENED_DESCRIPTION = 'Deafened';
export const MUTED_DESCRIPTION = 'Muted';

export function resolveOverlay(s: OverlayInputs): OverlayChoice {
    if (s.hasMention) return { kind: 'mention', description: MENTION_DESCRIPTION };
    if (s.inCall && s.isDeafened) return { kind: 'deafened', description: DEAFENED_DESCRIPTION };
    if (s.inCall && s.isMuted) return { kind: 'muted', description: MUTED_DESCRIPTION };
    if (s.unreadCount > 0) return { kind: 'unread', description: `${s.unreadCount} unread` };
    return { kind: 'none', description: '' };
}

// ── Palette ──────────────────────────────────────────────────────────────────
// mute / deafen: red-600 backdrop, white glyph (4.8:1) — the same red family as
// the red-500 MicOff/HeadphoneOff the participant cards draw.
// mention: the app's mention pill is `--flash` #FF6B5E with `--on-flash`
// #3A0E0A text (cl-kit.css, offscreen-unread.css); white on coral fails
// contrast, so the "@" is the dark on-flash ink, same as the pill.
// Each backdrop gets a ~1px darker rim so it separates from a light taskbar.
type RGB = readonly [number, number, number];
interface Look { bg: RGB; rim: RGB; ink: RGB }
const LOOKS: Record<Exclude<OverlayKind, 'none' | 'unread'>, Look> = {
    mention:  { bg: [0xFF, 0x6B, 0x5E], rim: [0xB2, 0x3A, 0x30], ink: [0x3A, 0x0E, 0x0A] },
    deafened: { bg: [0xDC, 0x26, 0x26], rim: [0x99, 0x1B, 0x1B], ink: [0xFF, 0xFF, 0xFF] },
    muted:    { bg: [0xDC, 0x26, 0x26], rim: [0x99, 0x1B, 0x1B], ink: [0xFF, 0xFF, 0xFF] },
};
const UNREAD_FILL: RGB = [240, 71, 71]; // #F04747 — unchanged

// ── lucide path data (24x24 viewBox, stroke icons) ───────────────────────────
const GLYPH_PATHS: Record<'mention' | 'deafened' | 'muted', string[]> = {
    // AtSign
    mention: [
        'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z', // <circle cx=12 cy=12 r=4>
        'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8',
    ],
    // HeadphoneOff
    deafened: [
        'M21 14h-1.343',
        'M9.128 3.47A9 9 0 0 1 21 12v3.343',
        'm2 2 20 20',
        'M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3',
        'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364',
    ],
    // MicOff
    muted: [
        'M12 19v3',
        'M15 9.34V5a3 3 0 0 0-5.68-1.33',
        'M16.95 16.95A7 7 0 0 1 5 12v-2',
        'M18.89 13.23A7 7 0 0 0 19 12v-2',
        'm2 2 20 20',
        'M9 9v3a3 3 0 0 0 5.12 2.12',
    ],
};

type Pt = readonly [number, number];

/** Flatten an SVG path (M m L l H h V v A a Z z) to polylines. */
export function flattenPath(d: string): Pt[][] {
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
    const out: Pt[][] = [];
    let cur: Pt[] = [];
    let x = 0, y = 0, sx = 0, sy = 0, i = 0;
    let cmd = '';
    const num = (): number => parseFloat(tokens[i++]);
    const flush = (): void => { if (cur.length > 1) out.push(cur); cur = []; };
    while (i < tokens.length) {
        if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
        const rel = cmd === cmd.toLowerCase();
        switch (cmd.toUpperCase()) {
            case 'M': {
                flush();
                const nx = num(), ny = num();
                x = rel ? x + nx : nx; y = rel ? y + ny : ny;
                sx = x; sy = y; cur = [[x, y]];
                cmd = rel ? 'l' : 'L'; // implicit lineto after the first pair
                break;
            }
            case 'L': {
                const nx = num(), ny = num();
                x = rel ? x + nx : nx; y = rel ? y + ny : ny;
                cur.push([x, y]);
                break;
            }
            case 'H': { const nx = num(); x = rel ? x + nx : nx; cur.push([x, y]); break; }
            case 'V': { const ny = num(); y = rel ? y + ny : ny; cur.push([x, y]); break; }
            case 'A': {
                const rx0 = num(), ry0 = num(), rot = num(), large = num(), sweep = num();
                const nx = num(), ny = num();
                const ex = rel ? x + nx : nx, ey = rel ? y + ny : ny;
                for (const p of arcPoints(x, y, rx0, ry0, rot, large !== 0, sweep !== 0, ex, ey)) cur.push(p);
                x = ex; y = ey;
                break;
            }
            case 'Z': { cur.push([sx, sy]); x = sx; y = sy; flush(); break; }
            default:
                throw new Error(`overlay-glyphs: unsupported path command "${cmd}"`);
        }
    }
    flush();
    return out;
}

/** SVG arc (endpoint form) → points along it, excluding the start point. */
function arcPoints(
    x1: number, y1: number, rx: number, ry: number, rotDeg: number,
    large: boolean, sweep: boolean, x2: number, y2: number,
): Pt[] {
    if (x1 === x2 && y1 === y2) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return [[x2, y2]];
    const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
    const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number): number => {
        const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 24)));
    const pts: Pt[] = [];
    for (let k = 1; k <= steps; k++) {
        const t = t1 + (dt * k) / steps;
        const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
        pts.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]);
    }
    pts[pts.length - 1] = [x2, y2]; // no accumulated drift at the endpoint
    return pts;
}

// ── Rasteriser ───────────────────────────────────────────────────────────────

const SS = 4; // 4x4 samples per pixel

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = px - a[0], wy = py - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const dx = px - (a[0] + t * vx), dy = py - (a[1] + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
}

/** Glyph strokes in pixel space for a size×size image. */
function glyphSegments(kind: 'mention' | 'deafened' | 'muted', size: number): { segs: Array<[Pt, Pt]>; half: number } {
    // The glyph box is 80% of the image (lucide keeps 2 units of padding inside its 24-unit box, so the ink is ~67%). Small (16 px) renders get a heavier
    // stroke in glyph units so lines stay ~1 px wide instead of dissolving.
    const box = size * 0.8;
    const scale = box / 24;
    const off = (size - box) / 2;
    const strokeUnits = size >= 24 ? 2.2 : 2.7;
    const segs: Array<[Pt, Pt]> = [];
    for (const d of GLYPH_PATHS[kind]) {
        for (const poly of flattenPath(d)) {
            for (let k = 1; k < poly.length; k++) {
                segs.push([
                    [off + poly[k - 1][0] * scale, off + poly[k - 1][1] * scale],
                    [off + poly[k][0] * scale, off + poly[k][1] * scale],
                ]);
            }
        }
    }
    return { segs, half: (strokeUnits * scale) / 2 };
}

/** RGBA pixels (size*size*4) for a glyph overlay: disc + rim + glyph. */
export function rasterizeGlyph(kind: 'mention' | 'deafened' | 'muted', size: number): Uint8Array {
    const look = LOOKS[kind];
    const { segs, half } = glyphSegments(kind, size);
    const c = size / 2;
    const r = size / 2 - Math.max(0.5, size / 64); // leave a hair of margin for the edge
    const rim = Math.max(1, size / 32);
    const px = new Uint8Array(size * size * 4);
    const n = SS * SS;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let cover = 0, sr = 0, sg = 0, sb = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
                    const dist = Math.hypot(fx - c, fy - c);
                    if (dist > r) continue;
                    cover++;
                    let col: RGB = dist > r - rim ? look.rim : look.bg;
                    // Keep the glyph clear of the rim.
                    if (dist <= r - rim * 0.5) {
                        for (const [a, b] of segs) {
                            if (distToSegment(fx, fy, a, b) <= half) { col = look.ink; break; }
                        }
                    }
                    sr += col[0]; sg += col[1]; sb += col[2];
                }
            }
            const o = (y * size + x) * 4;
            if (cover > 0) {
                px[o] = Math.round(sr / cover); px[o + 1] = Math.round(sg / cover); px[o + 2] = Math.round(sb / cover);
                px[o + 3] = Math.round((cover / n) * 255);
            }
        }
    }
    return px;
}

/** Anti-aliased solid disc (the unread dot). */
export function rasterizeDisc(size: number, r: number, fill: RGB): Uint8Array {
    const px = new Uint8Array(size * size * 4);
    const c = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dist = Math.hypot(x - c + 0.5, y - c + 0.5);
            const alpha = dist <= r - 0.5 ? 255 : dist < r + 0.5 ? Math.round((r + 0.5 - dist) * 255) : 0;
            const o = (y * size + x) * 4;
            if (alpha > 0) { px[o] = fill[0]; px[o + 1] = fill[1]; px[o + 2] = fill[2]; px[o + 3] = alpha; }
        }
    }
    return px;
}

/** RGBA pixels for any non-'none' overlay kind at `size`. */
export function rasterizeOverlay(kind: Exclude<OverlayKind, 'none'>, size: number): Uint8Array {
    return kind === 'unread' ? rasterizeDisc(size, size * 0.475, UNREAD_FILL) : rasterizeGlyph(kind, size);
}

/** Sizes the overlay is built at. Windows scales one HICON to 16/20/24/32 for
 *  the taskbar's DPI, so a single 32 px master (what the call overlay has
 *  always used) is downscaled — the glyph is drawn heavy enough to survive
 *  the 16 px case. The unread dot keeps its historical 20 px / r 9.5. */
export const OVERLAY_SIZE = 32;
export const UNREAD_SIZE = 20;

// ── PNG encoding (pure Node: zlib only) ──────────────────────────────────────
// nativeImage.createFromDataURL cannot decode SVG on Windows' main process —
// only PNG/JPEG — hence hand-built PNGs.

const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        t[i] = c;
    }
    return t;
})();

function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeB = Buffer.from(type, 'ascii');
    const lenB = Buffer.alloc(4);
    lenB.writeUInt32BE(data.length, 0);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
    return Buffer.concat([lenB, typeB, data, crcB]);
}

/** Encode width×height RGBA pixels as a PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (None) per row
    for (let y = 0; y < height; y++) {
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The PNG for an overlay kind at its production size. */
export function buildOverlayPng(kind: Exclude<OverlayKind, 'none'>): Buffer {
    const size = kind === 'unread' ? UNREAD_SIZE : OVERLAY_SIZE;
    return encodeRgbaPng(size, size, rasterizeOverlay(kind, size));
}
