/**
 * What a media file IS, from its bytes (pure; 2026-11-24, embeds-media-everywhere).
 *
 * The sender's unfurler decides "image / GIF / video" by CONTENT, never by the
 * URL's extension: a Discord CDN link ends in `.gif?ex=…&is=…&hm=…`, Gravatar
 * and picsum serve images at paths with no extension, i.imgur.com/<id> can
 * redirect to an HTML page, and Tenor sends a 9.5 MB GIF to a request that asked
 * for 64 KB. So main reads the first bytes (media-probe.ts, a ranged GET) and
 * this module reads them:
 *
 *   GIF          size; animated = a second image descriptor, or the NETSCAPE2.0
 *                looping extension;
 *   PNG          size; animated = an `acTL` chunk before the first IDAT (APNG);
 *   JPEG         size from the first SOFn marker;
 *   WebP         size (VP8 / VP8L / VP8X); animated = the VP8X animation flag;
 *   AVIF         `ftyp` brand avif / avis (avis = animated);
 *   MP4 / MOV    `ftyp` (brand `qt  ` = QuickTime); from `moov`: duration
 *                (mvhd), each track's kind (hdlr vide / soun) and the video
 *                track's size (tkhd). A file whose `moov` comes after the first
 *                bytes (not "fast start") says nothing more: `complete: false`;
 *   WebM         the EBML magic.
 *
 * Everything is bounds-checked; a truncated or hostile file gives less, never
 * a throw. `isShortLoop`: a video with no audio track, at most
 * SHORT_LOOP_MAX_S long, is a GIF (drawn and played under the GIF rules).
 */

export type SniffedMime = 'image/gif' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'video/mp4' | 'video/quicktime' | 'video/webm';

export interface MediaFacts {
    mime: SniffedMime;
    width?: number;
    height?: number;
    /** An image with more than one frame (GIF, APNG, animated WebP / AVIF). Undefined when the bytes did not tell. */
    animated?: boolean;
    durationS?: number;
    /** Video only, when `moov` was read: is there an audio / a video track? */
    hasAudio?: boolean;
    hasVideo?: boolean;
    /** Video only: false when the container index (`moov`) was not in the bytes read. */
    complete?: boolean;
}

/** A video this short with no sound track is a GIF (plan §6: "≤ 15 s, no audio track"). */
export const SHORT_LOOP_MAX_S = 15;

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, n: number) => (o + n <= b.length ? String.fromCharCode(...b.subarray(o, o + n)) : '');
const dim = (n: number | undefined) => (n !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined);

function gifFacts(b: Uint8Array): MediaFacts {
    const out: MediaFacts = { mime: 'image/gif', width: dim(u16le(b, 6)), height: dim(u16le(b, 8)) };
    // Walk the blocks: header (13) + global colour table.
    let o = 13;
    const flags = b[10];
    if (flags & 0x80) o += 3 * (1 << ((flags & 7) + 1));
    let frames = 0;
    let netscape = false;
    for (let guard = 0; o < b.length && guard < 100_000; guard++) {
        const t = b[o];
        if (t === 0x3b) break; // trailer
        if (t === 0x21) {
            // Extension: label, then sub-blocks.
            const label = b[o + 1];
            if (label === 0xff && ascii(b, o + 3, 11) === 'NETSCAPE2.0') netscape = true;
            o += 2;
            while (o < b.length && b[o] !== 0) o += b[o] + 1;
            o += 1;
            continue;
        }
        if (t === 0x2c) {
            frames++;
            if (frames >= 2) break;
            if (o + 10 > b.length) break;
            const lf = b[o + 9];
            o += 10;
            if (lf & 0x80) o += 3 * (1 << ((lf & 7) + 1));
            o += 1; // LZW minimum code size
            while (o < b.length && b[o] !== 0) o += b[o] + 1;
            o += 1;
            continue;
        }
        break; // not a GIF block: stop
    }
    if (frames >= 2 || netscape) out.animated = true;
    else if (o < b.length && b[o] === 0x3b) out.animated = false; // read to the trailer: one frame
    return out;
}

function pngFacts(b: Uint8Array): MediaFacts {
    const out: MediaFacts = { mime: 'image/png', width: dim(u32be(b, 16)), height: dim(u32be(b, 20)) };
    let o = 8;
    for (let guard = 0; o + 8 <= b.length && guard < 10_000; guard++) {
        const len = u32be(b, o);
        const type = ascii(b, o + 4, 4);
        if (type === 'acTL') { out.animated = true; break; }
        if (type === 'IDAT') { out.animated = false; break; }
        o += 12 + len;
    }
    return out;
}

function jpegFacts(b: Uint8Array): MediaFacts {
    const out: MediaFacts = { mime: 'image/jpeg', animated: false };
    let o = 2;
    for (let guard = 0; o + 9 < b.length && guard < 10_000; guard++) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1];
        if (m === 0xff) { o++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            out.height = dim(u16be(b, o + 5));
            out.width = dim(u16be(b, o + 7));
            break;
        }
        if (m === 0xda) break; // start of scan without a SOF: give up
        o += 2 + u16be(b, o + 2);
    }
    return out;
}

function webpFacts(b: Uint8Array): MediaFacts {
    const out: MediaFacts = { mime: 'image/webp' };
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X' && b.length >= 30) {
        out.animated = (b[20] & 0x02) !== 0;
        out.width = dim(u24le(b, 24) + 1);
        out.height = dim(u24le(b, 27) + 1);
    } else if (chunk === 'VP8 ' && b.length >= 30) {
        out.animated = false;
        out.width = dim(u16le(b, 26) & 0x3fff);
        out.height = dim(u16le(b, 28) & 0x3fff);
    } else if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
        out.animated = false;
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        out.width = dim((bits & 0x3fff) + 1);
        out.height = dim(((bits >>> 14) & 0x3fff) + 1);
    }
    return out;
}

interface Box { type: string; start: number; body: number; end: number }

/** The boxes in b[from, to): bounded, stops at anything malformed. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
    const out: Box[] = [];
    let o = from;
    while (o + 8 <= to && out.length < 512) {
        let size = u32be(b, o);
        const type = ascii(b, o + 4, 4);
        let body = o + 8;
        if (size === 1) {
            if (o + 16 > to) break;
            // 64-bit size: only the low 32 bits can be meaningful here.
            size = u32be(b, o + 12) + u32be(b, o + 8) * 2 ** 32;
            body = o + 16;
        } else if (size === 0) {
            size = to - o; // to the end
        }
        if (size < body - o) break;
        out.push({ type, start: o, body, end: o + size });
        o += size;
    }
    return out;
}

function mp4Facts(b: Uint8Array): MediaFacts {
    const brand = ascii(b, 8, 4);
    const out: MediaFacts = { mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', complete: false };
    const top = boxes(b, 0, b.length);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov || moov.end > b.length) return out;
    out.complete = true;
    let audio = false;
    let video = false;
    for (const x of boxes(b, moov.body, moov.end)) {
        if (x.type === 'mvhd') {
            const v = b[x.body];
            const scale = v === 1 ? u32be(b, x.body + 20) : u32be(b, x.body + 12);
            const dur = v === 1 ? u32be(b, x.body + 24) * 2 ** 32 + u32be(b, x.body + 28) : u32be(b, x.body + 16);
            if (scale > 0 && dur > 0) {
                const s = dur / scale;
                if (Number.isFinite(s) && s > 0 && s <= 86400) out.durationS = Math.round(s * 100) / 100;
            }
        } else if (x.type === 'trak') {
            let handler = '';
            let w: number | undefined;
            let h: number | undefined;
            for (const t of boxes(b, x.body, Math.min(x.end, b.length))) {
                if (t.type === 'tkhd') {
                    // Width / height are the box's last 8 bytes, 16.16 fixed point.
                    w = Math.round(u32be(b, t.end - 8) / 65536);
                    h = Math.round(u32be(b, t.end - 4) / 65536);
                } else if (t.type === 'mdia') {
                    const hdlr = boxes(b, t.body, Math.min(t.end, b.length)).find((m) => m.type === 'hdlr');
                    if (hdlr) handler = ascii(b, hdlr.body + 8, 4);
                }
            }
            if (handler === 'soun') audio = true;
            if (handler === 'vide') {
                video = true;
                if (!out.width && dim(w) && dim(h)) { out.width = w; out.height = h; }
            }
        }
    }
    out.hasAudio = audio;
    out.hasVideo = video;
    return out;
}

/** The media type and facts of a file's first bytes; null when it is none of the types above (HTML, JSON, text, …). */
export function sniffMedia(bytes: Uint8Array): MediaFacts | null {
    const b = bytes;
    if (b.length < 12) {
        if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return gifFacts(b);
        return null;
    }
    if (ascii(b, 0, 4) === 'GIF8') return gifFacts(b);
    if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return pngFacts(b);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegFacts(b);
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpFacts(b);
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', complete: false };
    if (ascii(b, 4, 4) === 'ftyp') {
        const brand = ascii(b, 8, 4);
        if (brand === 'avif') return { mime: 'image/avif', animated: false };
        if (brand === 'avis') return { mime: 'image/avif', animated: true };
        // Any other ISO-BMFF brand (isom, mp41, mp42, avc1, iso5, M4V , qt  , dash, …) is a video container.
        return mp4Facts(b);
    }
    return null;
}

/** A GIF-like video: no sound track and short. Unknown facts (moov not read) are never a loop. */
export function isShortLoop(f: Pick<MediaFacts, 'mime' | 'hasAudio' | 'durationS'> | null | undefined): boolean {
    return !!f && f.mime.startsWith('video/') && f.hasAudio === false && typeof f.durationS === 'number' && f.durationS > 0 && f.durationS <= SHORT_LOOP_MAX_S;
}

// ── Expiring / signed media links ─────────────────────────────────────────

const DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'cdn.discord.com', 'media.discord.com']);

/**
 * Does this media link carry an expiring signature (so a reader opening it
 * later will get a 404)? Generic, by the signing schemes CDNs actually use:
 *   - Discord attachments: `ex` (hex expiry) + `hm` (HMAC) — and any link on
 *     Discord's attachment paths, which have required them since 2023;
 *   - AWS SigV4 presigned (`X-Amz-Expires` / `X-Amz-Signature`), Google Cloud
 *     (`X-Goog-Expires` / `X-Goog-Signature`, `GoogleAccessId`+`Expires`+`Signature`),
 *     CloudFront (`Expires` / `Policy` + `Signature` + `Key-Pair-Id`), Azure SAS
 *     (`se` + `sig`), Facebook / Instagram CDN (`oe` + `oh`);
 *   - otherwise an expiry-named parameter holding a timestamp next to a
 *     signature-named one (`expires=1732400000&signature=…`, `exp=…&token=…`).
 * A signature alone (picsum's `hmac=`, Reddit preview's `s=`) is not expiry.
 */
export function isExpiringMediaUrl(raw: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    const host = u.hostname.toLowerCase();
    const q = new Map<string, string>();
    for (const [k, v] of u.searchParams) q.set(k.toLowerCase(), v);
    const has = (...k: string[]) => k.every((x) => q.has(x));
    if (DISCORD_MEDIA_HOSTS.has(host) && (/^\/(attachments|ephemeral-attachments)\//.test(u.pathname) || has('ex', 'hm'))) return true;
    if (has('ex', 'hm') && /^[0-9a-f]{6,16}$/i.test(q.get('ex')!)) return true;
    if (has('x-amz-signature') && (q.has('x-amz-expires') || q.has('x-amz-date'))) return true;
    if (has('x-goog-signature') && q.has('x-goog-expires')) return true;
    if (has('signature', 'key-pair-id') && (q.has('expires') || q.has('policy'))) return true;
    if (has('googleaccessid', 'expires', 'signature')) return true;
    if (has('se', 'sig') && q.has('sv')) return true;
    if (has('oe', 'oh')) return true;
    const EXP = ['expires', 'expire', 'expiry', 'exp', 'e', 'expiration', 'validto', 'valid_until', 'deadline'];
    const SIG = ['signature', 'sig', 'token', 'hmac', 'hash', 'hdnts', 'auth', 'sign', 'st', 'md5', 's'];
    const ts = (v: string) => /^\d{9,13}$/.test(v) || /^[0-9a-f]{8}$/i.test(v);
    return EXP.some((k) => q.has(k) && ts(q.get(k)!)) && SIG.some((k) => q.has(k) && q.get(k)!.length >= 8);
}
