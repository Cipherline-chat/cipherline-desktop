/**
 * e2eeIdrPpsRetry — H.264 IDR keyframes are re-encrypted (fresh IV) until a libwebrtc receiver can still read
 * pic_parameter_set_id from the transmitted bytes (libwebrtc's kMaxPpsIdEncryptAttempts, for LiveKit's JS cryptor).
 *
 * Everything below runs the REAL livekit-client E2EE worker (dist/livekit-client.e2ee.worker.mjs) as sender and as
 * receiver, with real x264 keyframes (e2eeIdrPpsRetry.fixtures.ts: slice_type 7, SEI, AUD, multi-slice, mixed 3/4-byte
 * start codes). The "receiver" oracle (`libwebrtcReceiver`) is written independently of the production parser
 * (bit-string based) from libwebrtc m150: video_rtp_depacketizer_h264.cc + pps_parser.cc ParseSliceHeader
 * (ParseRbsp, then three ue(v): first_mb_in_slice, slice_type, pic_parameter_set_id) + h26x_packet_buffer.cc
 * FixH264Packet (an IDR whose id names no known PPS is dropped; here the only PPS the stream announced has id 0).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { findNaluIndices, installAnnexBCanonicalizer, type EncodedFrameLike } from './e2eeAnnexB';
import {
    createIdrPpsRetry, idrPpsIdAsReceiverReads, parseRbsp, parseSliceHeaderPpsId, firstH264Slice, MAX_PPS_ID_ATTEMPTS, MAX_PPS_ATTEMPTS_CAP, ENCRYPTION_OVERHEAD_BYTES, type PpsRetryStats,
} from './e2eeIdrPpsRetry';
import { X264_HIGH, X264_HIGH_AUD_3SLICE, X264_BASELINE_CAVLC } from './e2eeIdrPpsRetry.fixtures';

const u8 = (...b: number[]) => Uint8Array.from(b);
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const ab = (a: Uint8Array): ArrayBuffer => a.slice().buffer as ArrayBuffer;
const SC4 = u8(0, 0, 0, 1);
const SC3 = u8(0, 0, 1);
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** WebRTC's receiver re-inserts {0,0,0,1} before every NAL unit it gets. */
function overTheWire(frame: Uint8Array): Uint8Array {
    return cat(...findNaluIndices(frame).flatMap(n => [SC4, frame.subarray(n.payload, n.payload + n.size)]));
}
/** Same bytes with every start code shortened to 3 bytes (what some encoders write). */
function toSc3(frame: Uint8Array): Uint8Array {
    return cat(...findNaluIndices(frame).flatMap(n => [SC3, frame.subarray(n.payload, n.payload + n.size)]));
}

// ── independent oracle ────────────────────────────────────────────────────────

const bitsOf = (bytes: number[]) => bytes.map(x => x.toString(2).padStart(8, '0')).join('');
function ueAll(bits: string, count: number): number[] | null {
    const out: number[] = []; let p = 0;
    for (let k = 0; k < count; k++) {
        const m = /^0*1/.exec(bits.slice(p));
        if (!m) return null;
        const z = m[0].length - 1;
        if (z >= 32 || p + m[0].length + z > bits.length) return null;
        const info = z ? parseInt(bits.slice(p + m[0].length, p + m[0].length + z), 2) : 0;
        out.push(2 ** z - 1 + info);
        p += m[0].length + z;
    }
    return out;
}
/** What libwebrtc's receiver learns from the first slice of the frame as it arrives: {sliceType, ppsId} or null (parse failure). */
function libwebrtcReceiver(wire: Uint8Array): { nalType: number; sliceType: number; ppsId: number } | null {
    const idx = findNaluIndices(wire);
    const n = idx.find(x => [1, 5].includes(wire[x.payload] & 0x1f));
    if (!n) return null;
    const raw = Array.from(wire.subarray(n.payload + 1, n.payload + n.size));
    const un: number[] = []; let z = 0;
    for (const x of raw) { if (z >= 2 && x === 3) { z = 0; continue; } un.push(x); z = x === 0 ? z + 1 : 0; }
    const f = ueAll(bitsOf(un.slice(0, 16)), 3);
    return f ? { nalType: wire[n.payload] & 0x1f, sliceType: f[1], ppsId: f[2] } : null;
}
const receiverAcceptsIdr = (wire: Uint8Array) => { const r = libwebrtcReceiver(wire); return !!r && r.nalType === 5 && r.ppsId === 0; };

// ── LiveKit's real worker, two isolated instances, IV spy ────────────────────

function livekitWorkerSource(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'dist', 'livekit-client.e2ee.worker.mjs');
        if (existsSync(p)) return readFileSync(p, 'utf8');
        dir = dirname(dir);
    }
    throw new Error('livekit-client e2ee worker not found');
}
interface WorkerInstance { send(data: unknown): void; errors: string[]; scope: Record<string, unknown>; ivs: Uint8Array[]; hook: { onEncrypt?: (n: number) => void } }
function loadWorker(code: string): WorkerInstance {
    const errors: string[] = [];
    const ivs: Uint8Array[] = [];
    const hook: { onEncrypt?: (n: number) => void } = {};
    const subtle = new Proxy(globalThis.crypto.subtle, {
        get(t, k) {
            const v = (t as never)[k] as unknown;
            if (k === 'encrypt') return (alg: { iv: ArrayBuffer }, ...rest: unknown[]) => { ivs.push(new Uint8Array(alg.iv).slice()); hook.onEncrypt?.(ivs.length); return (t.encrypt as (...a: unknown[]) => unknown)(alg, ...rest); };
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
    });
    const scope: Record<string, unknown> = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
        crypto: { subtle, getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a) },
        TextEncoder, TextDecoder, setTimeout, clearTimeout,
        ReadableStream, WritableStream, TransformStream, Uint8Array, ArrayBuffer, DataView, Map, Error, TypeError, Promise, Symbol, Math, Date,
        postMessage: (m: { kind?: string; data?: { error?: Error } }) => { if (m?.kind === 'error') errors.push(String(m.data?.error?.message)); },
    };
    scope.self = scope;
    vm.createContext(scope);
    vm.runInContext(code, scope);
    const handler = () => scope.onmessage as (ev: { data: unknown }) => void;
    return { send: data => handler()({ data }), errors, scope, ivs, hook };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const KEY_OPTS = { sharedKey: true, ratchetSalt: 'LKFrameEncryptionKey', ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 16, keySize: 128 };
async function keyed(w: WorkerInstance, key: Uint8Array) {
    w.send({ kind: 'init', data: { keyProviderOptions: KEY_OPTS, loglevel: 'silent' } });
    const material = await crypto.subtle.importKey('raw', ab(key), 'HKDF', false, ['deriveBits', 'deriveKey']);
    w.send({ kind: 'setKey', data: { participantIdentity: 'pub', isPublisher: true, key: material, keyIndex: 0 } });
    w.send({ kind: 'enable', data: { enabled: true, participantIdentity: 'pub' } });
    await tick(30);
}
class FakeFrame implements EncodedFrameLike {
    data: ArrayBuffer;
    type: 'key' | 'delta' | undefined;
    timestamp: number;
    constructor(data: ArrayBuffer, type: 'key' | 'delta' | undefined, timestamp: number) { this.data = data; this.type = type; this.timestamp = timestamp; }
    getMetadata() { return { synchronizationSource: 0x5eed, payloadType: 49 }; }
}
async function pipe(w: WorkerInstance, kind: 'encode' | 'decode', trackId: string, codec: string, frames: FakeFrame[]): Promise<FakeFrame[]> {
    const out: FakeFrame[] = [];
    let ctl!: ReadableStreamDefaultController<FakeFrame>;
    const readableStream = new ReadableStream<FakeFrame>({ start(c) { ctl = c; } });
    const writableStream = new WritableStream<FakeFrame>({ write(f) { out.push(f); } });
    w.send({ kind, data: { readableStream, writableStream, trackId, codec, participantIdentity: 'pub', isReuse: false } });
    await tick(10);
    for (const f of frames) ctl.enqueue(f);
    ctl.close();
    for (let i = 0; i < 400 && out.length < frames.length; i++) await tick(5);
    await tick(30);
    return out;
}

interface Sent { out: FakeFrame[]; ivs: Uint8Array[]; sender: WorkerInstance; key: Uint8Array; stats: PpsRetryStats | null }
/** Encrypt `frames` with the production wrapper installed (retry on/off). */
async function send(frames: { data: Uint8Array; type: 'key' | 'delta' | undefined }[], opts: { retry: boolean; codec?: string; key?: Uint8Array }): Promise<Sent> {
    const code = livekitWorkerSource();
    const key = opts.key ?? crypto.getRandomValues(new Uint8Array(32));
    const sender = loadWorker(code);
    const posted: { kind: string; data: PpsRetryStats }[] = [];
    let t = 0; // every read of the clock is 11 s later: each H.26x frame closes a stats window
    (sender.scope as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => { posted.push(m as never); };
    expect(installAnnexBCanonicalizer(sender.scope as never, () => (t += 11_000), { idrPpsRetry: opts.retry })).toBe(true);
    await keyed(sender, key);
    const codec = opts.codec ?? 'h264';
    sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec, participantIdentity: 'pub' } });
    const out = await pipe(sender, 'encode', 'cam', codec, frames.map((f, i) => new FakeFrame(ab(f.data), f.type, 1000 + i * 3000)));
    const sum = posted.filter(p => p.kind === 'cl:idr-pps-stats').map(p => p.data);
    const total = sum.length ? sum.reduce((a, b) => ({ checked: a.checked + b.checked, retried: a.retried + b.retried, extraAttempts: a.extraAttempts + b.extraAttempts, gaveUp: a.gaveUp + b.gaveUp, notEncrypted: a.notEncrypted + b.notEncrypted, timeouts: a.timeouts + b.timeouts })) : null;
    return { out, ivs: sender.ivs, sender, key, stats: total };
}
async function receive(enc: FakeFrame[], key: Uint8Array, codec = 'h264') {
    const receiver = loadWorker(livekitWorkerSource());
    await keyed(receiver, key);
    const wire = enc.map(f => new FakeFrame(ab(overTheWire(new Uint8Array(f.data))), f.type, f.timestamp));
    const dec = await pipe(receiver, 'decode', 'cam-r', codec, wire);
    return { dec, errors: receiver.errors.length };
}

const FIXTURES = { x264High: X264_HIGH.map(b64), x264Aud3Slice: X264_HIGH_AUD_3SLICE.map(b64), x264Baseline: X264_BASELINE_CAVLC.map(b64) };
const REPEATS = 10;
const keyframes = (list: Uint8Array[], sc: (f: Uint8Array) => Uint8Array = f => f) =>
    Array.from({ length: REPEATS }, () => list.map(f => ({ data: sc(f), type: 'key' as const }))).flat();

describe('fixtures are the shape that breaks (real x264 IDRs)', () => {
    it('every fixture is an IDR whose slice_type is 7 and whose pps id (0) is NOT in the clear prefix', () => {
        for (const [name, list] of Object.entries(FIXTURES)) {
            for (const f of list) {
                const r = libwebrtcReceiver(f)!;
                expect(r, name).toMatchObject({ nalType: 5, sliceType: 7, ppsId: 0 });
                // LiveKit leaves NAL header + 1 byte clear; slice_type 7 + first_mb 0 need 8 bits, so the pps id is bit 9.
                const s = firstH264Slice(f)!;
                expect(s.type).toBe(5);
            }
        }
        expect(libwebrtcReceiver(FIXTURES.x264Aud3Slice[0])).not.toBeNull();
    });
    it('the fixtures cover the prefix shapes: AUD, SEI, SPS, PPS, multi-slice, 3- and 4-byte start codes', () => {
        const types = (f: Uint8Array) => findNaluIndices(f).map(n => f[n.payload] & 0x1f);
        const all = Object.values(FIXTURES).flat().map(types);
        expect(all.some(t => t.includes(9))).toBe(true);
        expect(all.some(t => t.includes(6))).toBe(true);
        expect(all.some(t => t.filter(x => x === 5).length >= 3)).toBe(true);
        const f = FIXTURES.x264High[0];
        const idx = findNaluIndices(f);
        expect(idx.some(n => n.payload - n.start === 3)).toBe(true);
        expect(idx.some(n => n.payload - n.start === 4)).toBe(true);
    });
});

describe('production parser agrees with an independent oracle', () => {
    it('same pps id on plaintext fixtures and on 200 random ciphertext-shaped slices (3/4-byte codes, escapes)', () => {
        for (const f of Object.values(FIXTURES).flat()) expect(idrPpsIdAsReceiverReads(f)).toBe(0);
        let seed = 12345;
        const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 8;
        for (let i = 0; i < 200; i++) {
            const body = Uint8Array.from({ length: 40 }, () => (rnd() % 7 === 0 ? 0 : rnd() & 0xff));
            // clear prefix like LiveKit's (NAL header + first slice byte 0x88), escaped ciphertext after it
            const escaped = (() => { const o: number[] = []; let z = 0; for (const b of body) { if (b <= 3 && z >= 2) { o.push(3); z = 0; } o.push(b); z = b === 0 ? z + 1 : 0; } return Uint8Array.from(o); })();
            const wire = cat(SC4, u8(0x67, 1, 2, 3), SC3, u8(0x68, 4), (i & 1 ? SC3 : SC4), u8(0x65, 0x88), escaped);
            const o = libwebrtcReceiver(wire);
            expect(idrPpsIdAsReceiverReads(wire)).toBe(o ? o.ppsId : null);
        }
    });
    it('parseRbsp / exp-Golomb basics (libwebrtc vectors)', () => {
        expect(Array.from(parseRbsp(u8(0, 0, 3, 1, 0, 0, 3)))).toEqual([0, 0, 1, 0, 0]);
        expect(parseSliceHeaderPpsId(u8(0b10111000))).toBe(0);        // 1 | 011 | 1 → first_mb 0, slice_type 2, pps 0
        expect(parseSliceHeaderPpsId(u8(0b10001000, 0b01000000))).toBe(1); // 1 | 0001000(7) | 010 → pps 1
        expect(parseSliceHeaderPpsId(u8(0x88))).toBeNull();           // runs out of bits before pps id (slice_type 7 needs 8 bits)
        expect(parseSliceHeaderPpsId(u8(0, 0, 0, 0, 0))).toBeNull();  // >=32 leading zeros
    });
});

describe('before / after on the real worker (a) — what a libwebrtc receiver accepts', () => {
    it('BEFORE: encrypting once makes the receiver drop a measurable fraction (≈ half) of x264 IDRs', async () => {
        const frames = Object.values(FIXTURES).flatMap(l => keyframes(l));
        const { out } = await send(frames, { retry: false });
        expect(out).toHaveLength(frames.length);
        const ok = out.filter(f => receiverAcceptsIdr(new Uint8Array(f.data))).length;
        const rate = ok / out.length;
        // P(first ciphertext bit reads as the ue(v) '1' = id 0) = 1/2; n = 240 → ±0.05 is 3 sigma.
        expect(rate).toBeGreaterThan(0.3);
        expect(rate).toBeLessThan(0.7);
    }, 60_000);

    it('AFTER: with the retry every IDR is accepted within the attempt bound; ≈ 1 extra encryption per keyframe on average', async () => {
        const frames = Object.values(FIXTURES).flatMap(l => keyframes(l));
        const { out, ivs, stats } = await send(frames, { retry: true });
        expect(out).toHaveLength(frames.length);
        const ok = out.filter(f => receiverAcceptsIdr(new Uint8Array(f.data))).length;
        expect(ok / out.length).toBeGreaterThanOrEqual(0.99); // a miss needs 16 straight 50 % misses (1.5e-5 each)
        // one encryption per attempt, bounded by MAX per frame
        expect(ivs.length).toBeGreaterThan(frames.length);
        expect(ivs.length).toBeLessThanOrEqual(frames.length * MAX_PPS_ID_ATTEMPTS);
        const mean = ivs.length / frames.length;
        expect(mean).toBeGreaterThan(1.5); expect(mean).toBeLessThan(2.6); // geometric(1/2) → 2
        expect(stats).not.toBeNull();
        // the page-side report lags by one window (the last frame's counts are not posted yet)
        expect(stats!.checked).toBeGreaterThanOrEqual(frames.length - 2);
        expect(stats!.extraAttempts).toBeLessThanOrEqual(ivs.length - frames.length);
        expect(stats!.extraAttempts).toBeGreaterThan((ivs.length - frames.length) * 0.9);
        expect(stats!.gaveUp).toBeLessThanOrEqual(1);
    }, 60_000);

    it('start-code and prefix variants all pass: 3-byte codes everywhere, mixed, 4-byte everywhere, with SEI/AUD/SPS/PPS prefixes and 3 slices', async () => {
        for (const sc of [(f: Uint8Array) => toSc3(f), (f: Uint8Array) => overTheWire(f), (f: Uint8Array) => f]) {
            const frames = Object.values(FIXTURES).flatMap(l => keyframes(l, sc).slice(0, 16));
            const { out } = await send(frames, { retry: true });
            expect(out).toHaveLength(frames.length);
            expect(out.filter(f => receiverAcceptsIdr(new Uint8Array(f.data))).length / out.length).toBeGreaterThanOrEqual(0.95);
        }
    }, 60_000);

    it('a hardware-encoder-style IDR with slice_type 2 (pps id already in the clear) is checked once and never re-encrypted', async () => {
        // first_mb 0 '1', slice_type 2 '011', pps id 0 '1' → 0b1011 1... fits in the one clear byte.
        const hw = cat(SC4, u8(0x67, 0x42, 0xc0, 0x1f, 0xda), SC4, u8(0x68, 0xce, 0x3c, 0x80), SC4, u8(0x65, 0xb8, 0x40, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99));
        expect(libwebrtcReceiver(hw)).toMatchObject({ sliceType: 2, ppsId: 0 });
        const { out, ivs, stats } = await send(Array.from({ length: 30 }, () => ({ data: hw, type: 'key' as const })), { retry: true });
        expect(out).toHaveLength(30);
        expect(ivs).toHaveLength(30);
        expect(stats!.extraAttempts).toBe(0);
        expect(stats!.retried).toBe(0);
        expect(out.every(f => receiverAcceptsIdr(new Uint8Array(f.data)))).toBe(true);
    });
});

describe('nonce safety (b): every encryption under the key uses a distinct IV', () => {
    it('all IVs across retries and frames (one SSRC) are unique, and the retry IV differs only in the send-count word', async () => {
        const frames = Object.values(FIXTURES).flatMap(l => keyframes(l));
        // interleave delta frames so counters advance through non-keyframes too
        const mixed = frames.flatMap((f, i) => [f, { data: cat(SC4, u8(0x41, 0x9a, 1, 2, 3, 4, 5, 6)), type: 'delta' as const }].slice(0, i % 2 ? 2 : 1));
        const { ivs, out } = await send(mixed, { retry: true });
        const hex = ivs.map(v => Buffer.from(v).toString('hex'));
        expect(new Set(hex).size).toBe(hex.length);
        // the IV the receiver reads is the last attempt's: trailer = [..ciphertext][IV 12][0x0c][keyIndex]; escapes only touch bytes before the trailer's IV? (IV is escaped too) -> compare via set membership after unescape
        const lastWords = new Set(hex.map(h => h.slice(0, 16)));
        expect(lastWords.size).toBeGreaterThan(1); // ssrc||timestamp words vary per frame
        // same frame (same ssrc+timestamp words): the third word must differ for every attempt
        const byFrame = new Map<string, string[]>();
        for (const h of hex) byFrame.set(h.slice(0, 16), [...(byFrame.get(h.slice(0, 16)) ?? []), h.slice(16)]);
        expect([...byFrame.values()].some(v => v.length > 1)).toBe(true); // retries happened
        for (const v of byFrame.values()) expect(new Set(v).size).toBe(v.length);
        expect(out.length).toBe(mixed.length);
    }, 60_000);

    it('IV words: (ssrc, timestamp, timestamp - sendCount mod 0xffff) — the source of uniqueness, pinned against livekit-client 2.18.8', () => {
        const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', 'livekit-client', 'src', 'e2ee', 'worker', 'FrameCryptor.ts'), 'utf8');
        expect(src).toMatch(/ivView\.setUint32\(8, timestamp - \(sendCount % 0xffff\)\)/);
        expect(src).toMatch(/this\.sendCounts\.set\(synchronizationSource, sendCount \+ 1\)/);
    });
});

describe('the JS receiver (c) still decrypts every attempt\'s output', () => {
    it('desktop viewers: every retried and unretried keyframe decrypts byte-identical, no receiver errors', async () => {
        const frames = Object.values(FIXTURES).flatMap(l => keyframes(l).slice(0, 16));
        const s = await send(frames, { retry: true });
        const { dec, errors } = await receive(s.out, s.key);
        expect(errors).toBe(0);
        expect(dec).toHaveLength(frames.length);
        const byTs = new Map(dec.map(f => [f.timestamp, new Uint8Array(f.data)]));
        frames.forEach((f, i) => expect(eq(byTs.get(1000 + i * 3000)!, overTheWire(f.data)), `frame ${i}`).toBe(true));
        expect(s.ivs.length).toBeGreaterThan(frames.length); // retries really occurred
    }, 60_000);

    it('ciphertext is still ciphertext and a wrong key still decrypts nothing', async () => {
        const frames = FIXTURES.x264High.map(f => ({ data: f, type: 'key' as const }));
        const s = await send(frames, { retry: true });
        for (const [i, f] of s.out.entries()) expect(Buffer.from(f.data).includes(Buffer.from(frames[i].data.subarray(frames[i].data.length - 24)))).toBe(false);
        const { dec } = await receive(s.out, crypto.getRandomValues(new Uint8Array(32)));
        expect(dec).toHaveLength(0);
    });
});

describe('untouched paths (d)', () => {
    it('delta frames (even with an unreadable pps id), IDR-less key frames, audio, H.265 and VP8 are encrypted exactly once', async () => {
        const delta = (n: number) => cat(SC4, u8(0x41, 0x88), Uint8Array.from({ length: 30 }, (_, i) => 4 + ((i * 7 + n) % 200)));
        const frames = [
            ...Array.from({ length: 20 }, (_, i) => ({ data: delta(i), type: 'delta' as const })),
            ...Array.from({ length: 10 }, (_, i) => ({ data: cat(SC4, u8(0x41, 0x88), Uint8Array.from({ length: 30 }, (_, j) => 4 + j + i)), type: 'key' as const })), // 'key' but a non-IDR slice
        ];
        const s = await send(frames, { retry: true });
        expect(s.ivs).toHaveLength(frames.length);
        expect(s.stats).toBeNull(); // nothing was ever checked
        // H.265 IDR_W_RADL (type 19) marked key: no retry
        const h265 = cat(SC4, u8(0x40, 1, 9, 9), SC4, u8(0x42, 1, 9), SC4, u8(0x44, 1, 9), SC4, u8(19 << 1, 1, 0x88, 5, 6, 7, 8, 9, 10, 11, 12));
        const s2 = await send(Array.from({ length: 20 }, () => ({ data: h265, type: 'key' as const })), { retry: true, codec: 'h265' });
        expect(s2.ivs).toHaveLength(20);
        // VP8 key frame whose bytes look like an H.264 IDR must not be touched either (codec says vp8)
        const s3 = await send(Array.from({ length: 20 }, () => ({ data: FIXTURES.x264High[0], type: 'key' as const })), { retry: true, codec: 'vp8' });
        expect(s3.ivs).toHaveLength(20);
        // audio (no `type`)
        const s4 = await send(Array.from({ length: 10 }, () => ({ data: u8(1, 2, 3, 4, 5, 6), type: undefined })), { retry: true, codec: 'h264' });
        expect(s4.ivs).toHaveLength(10);
    }, 60_000);

    it('frame order is preserved around a retried keyframe, and the kill switch (idrPpsRetry:false) restores one encryption per frame', async () => {
        const d = (n: number) => ({ data: cat(SC4, u8(0x41, 0x9a, n, 2, 3, 4)), type: 'delta' as const });
        const kf = (i: number) => ({ data: FIXTURES.x264High[i], type: 'key' as const });
        const frames = [d(1), d(2), kf(0), d(3), kf(1), d(4), d(5), kf(2), d(6)];
        const on = await send(frames, { retry: true });
        expect(on.out.map(f => f.timestamp)).toEqual(frames.map((_, i) => 1000 + i * 3000));
        const off = await send(frames, { retry: false });
        expect(off.ivs).toHaveLength(frames.length);
    }, 60_000);
});

describe('createIdrPpsRetry mechanics (fake cryptor)', () => {
    const idr = cat(SC4, u8(0x65, 0x88, 0x80), Uint8Array.from({ length: 40 }, (_, i) => 5 + i)); // true pps id 0
    class F { data: ArrayBuffer; type: string; constructor(data: ArrayBuffer, type: string) { this.data = data; this.type = type; } getMetadata() { return {}; } }
    const CT_FILL = 70; // 4+3+70 = 77 = plainLen(47) + 30: the smallest length a real AES-GCM frame can have
    /** A "cryptor": encrypted = clear prefix + bytes chosen by `pick(attempt)`; counts how often it ran. */
    function harness(pick: (attempt: number) => number, opts: { maxAttempts?: number; drop?: (attempt: number) => boolean; passThrough?: (attempt: number) => boolean; holdTimeoutMs?: number; ppsId?: number; sink?: WritableStream<F> } = {}) {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, maxAttempts: opts.maxAttempts, holdTimeoutMs: opts.holdTimeoutMs });
        const sent: F[] = [];
        let attempts = 0;
        const cryptor = new TransformStream<F, F>({
            transform(f, c) {
                if (f.type !== 'key') { c.enqueue(f); return; }
                attempts++;
                if (opts.drop?.(attempts)) return;
                if (opts.passThrough?.(attempts)) { c.enqueue(f); return; } // LiveKit: !isEnabled() -> frame forwarded UNMODIFIED
                f.data = ab(cat(SC4, u8(0x65, 0x88, pick(attempts)), new Uint8Array(CT_FILL).fill(9)));
                c.enqueue(f);
            },
        });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(opts.sink ?? new WritableStream<F>({ write(f) { sent.push(f); } })));
        return { stats, sent, ctl, done, attempts: () => attempts };
    }
    const key = () => new F(ab(idr), 'key');
    // second byte after 0x88: first bit '1' → pps id 0 (match), first bit '0' → pps id >= 1 (mismatch)
    it('retries until the id reads right, then sends that attempt', async () => {
        const h = harness(a => (a < 4 ? 0x40 : 0x80));
        h.ctl.enqueue(key()); h.ctl.close(); await h.done;
        expect(h.attempts()).toBe(4);
        expect(h.sent).toHaveLength(1);
        expect(h.stats).toMatchObject({ checked: 1, retried: 1, extraAttempts: 3, gaveUp: 0 });
        expect(receiverAcceptsIdr(new Uint8Array(h.sent[0].data))).toBe(true);
    });
    it('is bounded: after MAX attempts the last (still unreadable) frame is sent, once', async () => {
        const h = harness(() => 0x40);
        h.ctl.enqueue(key()); h.ctl.enqueue(new F(ab(u8(1, 2, 3)), 'delta')); h.ctl.close(); await h.done;
        expect(h.attempts()).toBe(MAX_PPS_ID_ATTEMPTS);
        expect(h.sent).toHaveLength(2);
        expect(h.stats.gaveUp).toBe(1);
        expect(h.stats.extraAttempts).toBe(MAX_PPS_ID_ATTEMPTS - 1);
        expect(eq(new Uint8Array(h.sent[0].data), cat(SC4, u8(0x65, 0x88, 0x40), new Uint8Array(CT_FILL).fill(9)))).toBe(true); // ciphertext, never the plaintext
    });
    it('a cryptor that drops the frame releases the hold (timeout) and later frames still flow; the plaintext never reaches the sink', async () => {
        const h = harness(() => 0x80, { drop: a => a === 1, holdTimeoutMs: 40 });
        h.ctl.enqueue(key()); h.ctl.enqueue(new F(ab(u8(7, 7, 7)), 'delta')); h.ctl.close(); await h.done;
        expect(h.sent).toHaveLength(1);
        expect(h.stats.timeouts).toBe(1);
        expect(h.sent.every(f => !eq(new Uint8Array(f.data), idr))).toBe(true);
    });
    it('a retry attempt dropped by the cryptor never leaks the restored plaintext', async () => {
        const h = harness(() => 0x40, { drop: a => a === 2, holdTimeoutMs: 40 });
        h.ctl.enqueue(key()); h.ctl.close(); await h.done;
        expect(h.sent.every(f => !eq(new Uint8Array(f.data), idr))).toBe(true);
    });
});

describe('F1: a restored attempt never reaches the sink unless it is ciphertext-shaped (fake cryptor)', () => {
    const idr = cat(SC4, u8(0x65, 0x88, 0x80), Uint8Array.from({ length: 40 }, (_, i) => 5 + i));
    class F { data: ArrayBuffer; type: string; constructor(data: ArrayBuffer, type: string) { this.data = data; this.type = type; } getMetadata() { return {}; } }
    const mk = (pick: (a: number) => number, o: { passThrough?: (a: number) => boolean; drop?: (a: number) => boolean; maxAttempts?: number; ppsPlain?: Uint8Array; holdTimeoutMs?: number; failCheck?: boolean } = {}) => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const plain = o.ppsPlain ?? idr;
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, maxAttempts: o.maxAttempts, holdTimeoutMs: o.holdTimeoutMs });
        const sent: Uint8Array[] = [];
        let attempts = 0;
        const cryptor = new TransformStream<F, F>({
            transform(f, c) {
                if (f.type !== 'key') { c.enqueue(f); return; }
                attempts++;
                if (o.drop?.(attempts)) return;
                if (o.passThrough?.(attempts)) { c.enqueue(f); return; }
                f.data = ab(cat(SC4, u8(0x65, 0x88, pick(attempts)), new Uint8Array(70).fill(9)));
                c.enqueue(f);
            },
        });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data).slice()); } })));
        const push = (f: F) => ctl.enqueue(f);
        return { stats, sent, push, close: () => ctl.close(), done, attempts: () => attempts, plain, key: () => new F(ab(plain), 'key') };
    };
    it('attempt 2 passes the frame through unencrypted (E2EE disabled mid-retry): nothing is written, it is counted, the stream goes on', async () => {
        const h = mk(() => 0x40, { passThrough: a => a === 2 });
        h.push(h.key()); h.push(new F(ab(u8(7, 7, 7)), 'delta')); h.close(); await h.done;
        expect(h.sent.every(b => !eq(b, idr))).toBe(true);
        expect(h.sent).toHaveLength(1); // only the delta
        expect(h.stats.notEncrypted).toBe(1);
    });
    it('a pass-through on a LATER retry (attempt 4) is also refused', async () => {
        const h = mk(() => 0x40, { passThrough: a => a >= 4 });
        h.push(h.key()); h.close(); await h.done;
        expect(h.sent).toHaveLength(0);
        expect(h.stats.notEncrypted).toBe(1);
    });
    it('too-short "ciphertext" on a retry (plainLen+29) is refused; exactly plainLen+30 is accepted', async () => {
        const run = async (fill: number) => {
            const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
            const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats });
            const sent: Uint8Array[] = [];
            let n = 0;
            const cryptor = new TransformStream<F, F>({ transform(f, c) { n++; f.data = ab(cat(SC4, u8(0x65, 0x88, n === 1 ? 0x40 : 0x80), new Uint8Array(fill).fill(9))); c.enqueue(f); } });
            let ctl!: ReadableStreamDefaultController<F>;
            const src = new ReadableStream<F>({ start(c) { ctl = c; } });
            const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data)); } })));
            ctl.enqueue(new F(ab(idr), 'key')); ctl.close(); await done;
            return { sent, stats };
        };
        const plainLen = idr.length;
        // attempt 1 must itself be unreadable-but-legal (any length: first attempt is not gated), the retry is what is gated
        const short = await run(plainLen + ENCRYPTION_OVERHEAD_BYTES - 1 - 7);
        expect(short.sent).toHaveLength(0);
        expect(short.stats.notEncrypted).toBe(1);
        const ok = await run(plainLen + ENCRYPTION_OVERHEAD_BYTES - 7);
        expect(ok.sent).toHaveLength(1);
        expect(ok.stats.notEncrypted).toBe(0);
    });
    it('the FIRST attempt is not gated: with E2EE genuinely off (cryptor passes every frame) the keyframe is sent unchanged, no retry, no drop', async () => {
        const h = mk(() => 0x80, { passThrough: () => true });
        h.push(h.key()); h.close(); await h.done;
        expect(h.sent).toHaveLength(1);
        expect(eq(h.sent[0], idr)).toBe(true);
        expect(h.stats).toMatchObject({ checked: 1, retried: 0, extraAttempts: 0, notEncrypted: 0 });
    });
    it('the saved plaintext and the restored buffers are zeroed when a restored attempt is refused', async () => {
        const restoredBuffers: ArrayBuffer[] = [];
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats });
        let n = 0;
        const cryptor = new TransformStream<F, F>({
            transform(f, c) {
                n++;
                if (n === 2) { restoredBuffers.push(f.data); c.enqueue(f); return; } // pass-through: frame.data IS the restored buffer
                f.data = ab(cat(SC4, u8(0x65, 0x88, 0x40), new Uint8Array(70).fill(9))); c.enqueue(f);
            },
        });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write() {} })));
        ctl.enqueue(new F(ab(idr), 'key')); ctl.close(); await done;
        expect(restoredBuffers).toHaveLength(1);
        expect(new Uint8Array(restoredBuffers[0]).every(b => b === 0)).toBe(true);
    });
    it('every restored buffer of a successful multi-attempt frame is zeroed (the cryptor has overwritten frame.data)', async () => {
        const seen: ArrayBuffer[] = [];
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264' });
        let n = 0;
        const cryptor = new TransformStream<F, F>({
            transform(f, c) { n++; if (n > 1) seen.push(f.data); f.data = ab(cat(SC4, u8(0x65, 0x88, n < 4 ? 0x40 : 0x80), new Uint8Array(70).fill(9))); c.enqueue(f); },
        });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write() {} })));
        ctl.enqueue(new F(ab(idr), 'key')); ctl.close(); await done;
        expect(seen).toHaveLength(3);
        for (const b of seen) expect(new Uint8Array(b).every(x => x === 0)).toBe(true);
    });
});

describe('F3: ppsIdSurvives throwing, maxAttempts clamp (fake cryptor)', () => {
    const idr = cat(SC4, u8(0x65, 0x88, 0x80), Uint8Array.from({ length: 40 }, (_, i) => 5 + i));
    class F { data: ArrayBuffer; type: string; constructor(data: ArrayBuffer, type: string) { this.data = data; this.type = type; } getMetadata() { return {}; } }
    /** A frame whose `data` getter throws on the Nth read after the hold has copied it. */
    function booby(throwAfterReads: number, ct: Uint8Array) {
        let reads = 0; let cur: ArrayBuffer = ab(idr);
        const f = { type: 'key', getMetadata: () => ({}) } as unknown as F;
        Object.defineProperty(f, 'data', { get() { reads++; if (reads > throwAfterReads) throw new Error('boom'); return cur; }, set(v: ArrayBuffer) { cur = v; }, configurable: true });
        return { f, setCt: () => { cur = ab(ct); } };
    }
    it('a throw in the sink-side check drops a non-ciphertext-shaped frame and does not error the pipe', async () => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats });
        const sent: Uint8Array[] = [];
        const b = booby(1, cat(SC4, u8(0x65, 0x88, 0x40), new Uint8Array(70).fill(9)));
        const cryptor = new TransformStream<F, F>({ transform(f, c) { c.enqueue(f); } }); // reads of f.data: 1 (hold copy) then throws
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data)); } })));
        ctl.enqueue(b.f); ctl.enqueue(new F(ab(u8(7)), 'delta')); ctl.close();
        await expect(done).resolves.toBeUndefined();
        expect(sent).toHaveLength(1); // the delta only
        expect(stats.notEncrypted).toBe(1);
    });
    it('a throw with a ciphertext-shaped current attempt writes that encrypted attempt', async () => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats });
        const sent: Uint8Array[] = [];
        const ct = cat(SC4, u8(0x65, 0x88, 0x40), new Uint8Array(70).fill(9));
        let reads = 0; let cur: ArrayBuffer = ab(idr);
        const f = { type: 'key', getMetadata: () => ({}) } as unknown as F;
        Object.defineProperty(f, 'data', { get() { reads++; if (reads === 2) throw new Error('boom'); return cur; }, set(v: ArrayBuffer) { cur = v; }, configurable: true });
        // read 1 = the hold's copy, read 2 = the sink-side pps check (throws), read 3 = the fail-closed shape check
        const cryptor = new TransformStream<F, F>({ transform(x, c) { x.data = ab(ct); c.enqueue(x); } });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(x) { sent.push(new Uint8Array(x.data)); } })));
        ctl.enqueue(f); ctl.close(); await done;
        expect(sent).toHaveLength(1);
        expect(stats.notEncrypted).toBe(0);
        expect(eq(sent[0], ct)).toBe(true);
    });
    it('maxAttempts is clamped to [1, 64]', async () => {
        const run = async (maxAttempts: number) => {
            const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
            const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, maxAttempts });
            let n = 0;
            const cryptor = new TransformStream<F, F>({ transform(f, c) { n++; f.data = ab(cat(SC4, u8(0x65, 0x88, 0x40), new Uint8Array(70).fill(9))); c.enqueue(f); } });
            let ctl!: ReadableStreamDefaultController<F>;
            const src = new ReadableStream<F>({ start(c) { ctl = c; } });
            const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write() {} })));
            ctl.enqueue(new F(ab(idr), 'key')); ctl.close(); await done;
            return n;
        };
        expect(await run(1_000_000)).toBe(MAX_PPS_ATTEMPTS_CAP);
        expect(await run(0)).toBe(1);
        expect(await run(-5)).toBe(1);
        expect(await run(Number.NaN)).toBe(MAX_PPS_ID_ATTEMPTS);
        expect(await run(3)).toBe(3);
    });
});

describe('lifecycle and edge cases (fake cryptor)', () => {
    const idr = cat(SC4, u8(0x65, 0x88, 0x80), Uint8Array.from({ length: 40 }, (_, i) => 5 + i));
    class F { data: ArrayBuffer; type: string; constructor(data: ArrayBuffer, type: string) { this.data = data; this.type = type; } getMetadata() { return {}; } }
    const ct = (pps: number) => ab(cat(SC4, u8(0x65, 0x88, pps), new Uint8Array(70).fill(9)));
    it('the cryptor dropping attempt 2 (e.g. the key set vanished mid-retry) releases the hold by timeout; the next keyframe is encrypted and sent normally', async () => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, holdTimeoutMs: 40 });
        const sent: Uint8Array[] = [];
        let n = 0;
        const cryptor = new TransformStream<F, F>({ transform(f, c) { n++; if (n === 2) return; f.data = ct(n === 1 ? 0x40 : 0x80); c.enqueue(f); } });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data).slice()); } })));
        ctl.enqueue(new F(ab(idr), 'key')); ctl.enqueue(new F(ab(idr), 'key')); ctl.close(); await done;
        expect(stats.timeouts).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent.every(b => !eq(b, idr))).toBe(true);
    });
    it('the downstream sink closing/aborting while a keyframe is held writes nothing and releases pending', async () => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, holdTimeoutMs: 40 });
        const sent: Uint8Array[] = [];
        const cryptor = new TransformStream<F, F>({ transform() { /* swallow: the held frame never returns */ } });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const sinkAbort = vi.fn();
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data)); }, abort: sinkAbort })));
        ctl.enqueue(new F(ab(idr), 'key'));
        await new Promise(r2 => setTimeout(r2, 5));
        ctl.error(new Error('track ended'));
        await expect(done).rejects.toThrow('track ended');
        expect(sent).toHaveLength(0);
        expect(sinkAbort).toHaveBeenCalled();
    });
    it('toCryptor.enqueue throwing (readable side cancelled) drops the frame and never writes the restored plaintext', async () => {
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats, holdTimeoutMs: 200 });
        const sent: Uint8Array[] = [];
        const sink = r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data).slice()); } }));
        const rdr = r.hold.readable.getReader();
        const w = r.hold.writable.getWriter();
        const wr = sink.getWriter();
        const f = new F(ab(idr), 'key');
        const wp = w.write(f);
        const got = await rdr.read(); // the hold enqueued the frame to the "cryptor"
        expect(got.value).toBe(f);
        await rdr.cancel(); // cryptor side gone: the next enqueue throws
        f.data = ct(0x40); // attempt 1 came back unreadable
        await wr.write(f);
        await wp.catch(() => {});
        expect(sent.every(b => !eq(b, idr))).toBe(true);
        expect(sent).toHaveLength(0);
    });
    it('non-zero pps id (id 3, 5-bit code): retried until the receiver reads 3, then sent', async () => {
        // slice header bits for first_mb=0 ('1'), slice_type 7 ('0001000'), pps id 3 ('00100') = 1 0001000 00100 -> bytes 0x88 0x20
        const plain = cat(SC4, u8(0x65, 0x88, 0x20), Uint8Array.from({ length: 40 }, (_, i) => 5 + i));
        expect(idrPpsIdAsReceiverReads(plain)).toBe(3);
        const stats: PpsRetryStats = { checked: 0, retried: 0, extraAttempts: 0, gaveUp: 0, notEncrypted: 0, timeouts: 0 };
        const r = createIdrPpsRetry<F>({ codecOf: () => 'h264', stats });
        const sent: Uint8Array[] = [];
        let n = 0;
        const cryptor = new TransformStream<F, F>({ transform(f, c) { n++; f.data = ab(cat(SC4, u8(0x65, 0x88, n < 3 ? 0x80 : 0x20), new Uint8Array(70).fill(9))); c.enqueue(f); } });
        let ctl!: ReadableStreamDefaultController<F>;
        const src = new ReadableStream<F>({ start(c) { ctl = c; } });
        const done = src.pipeThrough(r.hold).pipeThrough(cryptor).pipeTo(r.wrapSink(new WritableStream<F>({ write(f) { sent.push(new Uint8Array(f.data).slice()); } })));
        ctl.enqueue(new F(ab(plain), 'key')); ctl.close(); await done;
        expect(n).toBe(3);
        expect(stats).toMatchObject({ checked: 1, retried: 1, extraAttempts: 2, gaveUp: 0, notEncrypted: 0 });
        expect(idrPpsIdAsReceiverReads(sent[0])).toBe(3);
    });
});

describe('F1 against the REAL LiveKit worker: E2EE switched off between attempt 1 and 2', () => {
    it('no trial ever puts the plaintext keyframe on the sink (the cryptor forwards the restored plaintext unmodified)', async () => {
        const code = livekitWorkerSource();
        const plain = FIXTURES.x264High[0];
        let dropped = 0;
        for (let trial = 0; trial < 24; trial++) {
            const sender = loadWorker(code);
            let t = 0;
            installAnnexBCanonicalizer(sender.scope as never, () => (t += 11_000));
            await keyed(sender, crypto.getRandomValues(new Uint8Array(32)));
            sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec: 'h264', participantIdentity: 'pub' } });
            sender.hook.onEncrypt = n => { if (n === 1) sender.send({ kind: 'enable', data: { enabled: false, participantIdentity: 'pub' } }); };
            const out = await pipe(sender, 'encode', 'cam', 'h264', [new FakeFrame(ab(plain), 'key', 1000)]);
            for (const f of out) expect(eq(new Uint8Array(f.data), plain), `trial ${trial}`).toBe(false);
            if (out.length === 0) dropped++; // attempt 1 unreadable -> restored -> pass-through -> refused
        }
        expect(dropped).toBeGreaterThan(0); // a retry opportunity (attempt 1 unreadable, p=1/2 per trial) occurred
    }, 60_000);
});

describe('runtime kill switch (cl:idr-pps-config)', () => {
    it('{enabled:false} sent at worker start turns the retry off; it is consumed, not forwarded; default and malformed config stay on', async () => {
        const run = async (cfg: unknown | undefined) => {
            const code = livekitWorkerSource();
            const sender = loadWorker(code);
            const key = crypto.getRandomValues(new Uint8Array(32));
            let t = 0;
            installAnnexBCanonicalizer(sender.scope as never, () => (t += 11_000));
            await keyed(sender, key);
            if (cfg !== undefined) sender.send({ kind: 'cl:idr-pps-config', data: cfg });
            sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec: 'h264', participantIdentity: 'pub' } });
            const frames = Array.from({ length: 20 }, (_, i) => new FakeFrame(ab(FIXTURES.x264High[i % 3]), 'key', 1000 + i * 3000));
            await pipe(sender, 'encode', 'cam', 'h264', frames);
            return sender.ivs.length;
        };
        expect(await run({ enabled: false })).toBe(20);
        expect(await run(undefined)).toBeGreaterThan(20);
        expect(await run({})).toBeGreaterThan(20);
        expect(await run({ enabled: true })).toBeGreaterThan(20);
    }, 60_000);
    it('is re-enableable at the next stream (config is read per sender stream)', async () => {
        const sender = loadWorker(livekitWorkerSource());
        let t = 0;
        installAnnexBCanonicalizer(sender.scope as never, () => (t += 11_000));
        await keyed(sender, crypto.getRandomValues(new Uint8Array(32)));
        sender.send({ kind: 'cl:idr-pps-config', data: { enabled: false } });
        sender.send({ kind: 'cl:idr-pps-config', data: { enabled: true } });
        sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec: 'h264', participantIdentity: 'pub' } });
        await pipe(sender, 'encode', 'cam', 'h264', Array.from({ length: 20 }, (_, i) => new FakeFrame(ab(FIXTURES.x264High[i % 3]), 'key', 1000 + i * 3000)));
        expect(sender.ivs.length).toBeGreaterThan(20);
    }, 60_000);
});

describe('simulcast: two SSRCs, identical RTP timestamps, one cryptor (real LiveKit worker)', () => {
    it('same-timestamp frames on different SSRCs never share an IV, retries included', async () => {
        const sender = loadWorker(livekitWorkerSource());
        let t = 0;
        installAnnexBCanonicalizer(sender.scope as never, () => (t += 11_000));
        await keyed(sender, crypto.getRandomValues(new Uint8Array(32)));
        sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec: 'h264', participantIdentity: 'pub' } });
        class Ssrc extends FakeFrame { ssrc: number; constructor(d: ArrayBuffer, ty: 'key' | 'delta', ts: number, ssrc: number) { super(d, ty, ts); this.ssrc = ssrc; } getMetadata() { return { synchronizationSource: this.ssrc, payloadType: 49 }; } }
        const frames: FakeFrame[] = [];
        for (let i = 0; i < 24; i++) for (const ssrc of [0xaaaa0001, 0xbbbb0002]) frames.push(new Ssrc(ab(FIXTURES.x264High[i % 3]), 'key', 5000 + i * 3000, ssrc));
        const out = await pipe(sender, 'encode', 'cam', 'h264', frames);
        expect(out).toHaveLength(frames.length);
        const hex = sender.ivs.map(v => Buffer.from(v).toString('hex'));
        expect(new Set(hex).size).toBe(hex.length);
        expect(hex.length).toBeGreaterThan(frames.length); // retries happened
        expect(new Set(hex.map(h => h.slice(0, 8))).size).toBe(2); // both ssrcs reached the cryptor
    }, 60_000);
});

describe('cost', () => {
    it('checking one 400 KB keyframe is far below a millisecond (lazy scan; only the first slice is parsed)', () => {
        const big = cat(FIXTURES.x264High[0], new Uint8Array(400_000).fill(0x7f));
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) idrPpsIdAsReceiverReads(big);
        const per = (performance.now() - t0) / 2000;
        expect(per).toBeLessThan(0.2); // ms; typically ~0.002
    });
});

describe('page-side report', () => {
    it('worker stats message to counts only (no identities), junk ignored', async () => {
        const { idrPpsStatsFromMessage } = await import('./e2eeWorkerStats');
        expect(idrPpsStatsFromMessage({ kind: 'cl:idr-pps-stats', data: { checked: 5, retried: 3, extraAttempts: 4, gaveUp: 0, timeouts: 1, identity: 'x' } })).toEqual({ checked: 5, retried: 3, extra: 4, gaveUp: 0, notEncrypted: 0, timeouts: 1 });
        expect(idrPpsStatsFromMessage({ kind: 'cl:annexb-stats', data: {} })).toBeNull();
        expect(idrPpsStatsFromMessage(null)).toBeNull();
    });
});
