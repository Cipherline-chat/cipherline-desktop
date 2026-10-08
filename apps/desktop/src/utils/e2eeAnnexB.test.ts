/**
 * e2eeAnnexB — the sender-side start-code canonicalizer in front of LiveKit's
 * E2EE frame cryptor.
 *
 * The round-trip block runs the REAL livekit-client E2EE worker
 * (dist/livekit-client.e2ee.worker.mjs, two isolated instances = sender and
 * receiver) with WebRTC's H.26x framing in between: the sender's packetizer
 * splits at FindNaluIndices and the receiver's depacketizer re-inserts
 * {0,0,0,1} before every NAL unit. Positive control: with 3-byte start codes
 * and no canonicalizer, the receiver drops the frames (the field symptom);
 * with it, every frame arrives byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
    findNaluIndices, classifyAnnexB, canonicalizeAnnexB, canonicalizeFrame, isH26xFrame,
    installAnnexBCanonicalizer, ANNEXB_STATS_KIND, ANNEXB_STATS_EVERY_MS, type EncodedFrameLike,
} from './e2eeAnnexB';

const u8 = (...b: number[]) => Uint8Array.from(b);
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const ab = (a: Uint8Array): ArrayBuffer => a.slice().buffer as ArrayBuffer;
const SC4 = u8(0, 0, 0, 1);
const SC3 = u8(0, 0, 1);

/** Deterministic NAL body bytes that never form a start code / emulation sequence. */
function body(n: number, seed: number): Uint8Array {
    const o = new Uint8Array(n);
    let x = seed * 2654435761 >>> 0;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; o[i] = 4 + (x >>> 16) % 252; }
    return o;
}
// H.265 NAL headers (2 bytes): type << 1, then nuh_temporal_id_plus1 = 1.
const h265 = (type: number, len: number, seed: number) => cat(u8(type << 1, 1), body(len, seed));
// H.264 NAL header (1 byte).
const h264 = (hdr: number, len: number, seed: number) => cat(u8(hdr), body(len, seed));

function annexB(nalus: Uint8Array[], sc: (i: number) => Uint8Array): Uint8Array {
    return cat(...nalus.flatMap((n, i) => [sc(i), n]));
}
/** What the receiver's depacketizer hands its transform: {0,0,0,1} + every NAL unit WebRTC found. */
function overTheWire(frame: Uint8Array): Uint8Array {
    return cat(...findNaluIndices(frame).flatMap(n => [SC4, frame.subarray(n.payload, n.payload + n.size)]));
}

describe('findNaluIndices (WebRTC h264_common.cc semantics)', () => {
    it('splits 3- and 4-byte start codes; a 4-byte code takes the zero before it', () => {
        const f = cat(SC4, u8(0x40, 1, 9), SC3, u8(0x02, 1, 7, 7));
        expect(findNaluIndices(f)).toEqual([
            { start: 0, payload: 4, size: 3 },
            { start: 7, payload: 10, size: 4 },
        ]);
    });
    it('leading bytes before the first start code are not a NAL unit', () => {
        expect(findNaluIndices(cat(u8(9, 9), SC3, u8(0x26, 1, 5)))).toEqual([{ start: 2, payload: 5, size: 3 }]);
    });
    it('no start code → nothing (VP8/VP9/AV1 payloads, audio)', () => {
        expect(findNaluIndices(u8(0x9d, 0x01, 0x2a, 7, 7, 7))).toEqual([]);
    });
});

describe('classify / canonicalize', () => {
    const vps = h265(32, 10, 1), sps = h265(33, 20, 2), pps = h265(34, 6, 3), idr = h265(19, 50, 4), trail = h265(1, 40, 5);

    it('all-4-byte frames are canonical and left alone (no copy)', () => {
        const f = annexB([vps, sps, pps, idr], () => SC4);
        expect(classifyAnnexB(f)).toBe('canonical');
        expect(canonicalizeAnnexB(f)).toBeNull();
    });
    it('a 3-byte start code anywhere → rewritten to exactly what the receiver rebuilds', () => {
        for (const f of [annexB([trail], () => SC3), annexB([vps, sps, pps, idr], i => (i === 3 ? SC3 : SC4))]) {
            expect(classifyAnnexB(f)).toBe('short_start_code');
            const out = canonicalizeAnnexB(f)!;
            expect(out).toEqual(overTheWire(f));
            expect(canonicalizeAnnexB(out)).toBeNull(); // idempotent
        }
    });
    it('leading data is dropped, as WebRTC\'s packetizer drops it', () => {
        const f = cat(u8(7, 7), annexB([trail], () => SC4));
        expect(classifyAnnexB(f)).toBe('leading_data');
        expect(canonicalizeAnnexB(f)).toEqual(annexB([trail], () => SC4));
    });
    it('trailing zeros before a start code: WebRTC keeps all but the 4-byte code\'s one in the previous NAL — so does the canonical form', () => {
        const f = cat(SC4, pps, u8(0, 0), SC3, trail); // "pps 00 00 00 00 01 trail" = "pps 00" + 4-byte code
        expect(classifyAnnexB(f)).toBe('canonical');
        expect(canonicalizeAnnexB(f)).toBeNull();
        expect(f).toEqual(overTheWire(f));
        const g = cat(SC3, pps, u8(0, 0), SC3, trail); // first code short → rewritten, zeros preserved as WebRTC splits them
        expect(canonicalizeAnnexB(g)).toEqual(overTheWire(g));
    });
    it('not Annex B → untouched', () => {
        expect(classifyAnnexB(u8(0x9d, 0x01, 0x2a, 1, 2, 3))).toBe('not_annexb');
        expect(canonicalizeAnnexB(u8(0x9d, 0x01, 0x2a, 1, 2, 3))).toBeNull();
    });
});

describe('isH26xFrame (which frames the hook touches)', () => {
    const video = (data: Uint8Array, pt?: number): EncodedFrameLike => ({ data: data.slice().buffer, type: 'delta', getMetadata: () => ({ payloadType: pt }) });
    const map = new Map<number, string>([[96, 'vp8'], [103, 'h264'], [49, 'h265']]);
    it('codec from the payload-type map first, then the pinned codec — like the cryptor', () => {
        expect(isH26xFrame(video(u8(1, 2, 3), 103), map, undefined)).toBe(true);
        expect(isH26xFrame(video(u8(0, 0, 1, 2), 96), map, 'h264')).toBe(false); // VP8 by PT wins
        expect(isH26xFrame(video(u8(1, 2, 3), 77), map, 'h265')).toBe(true);
        expect(isH26xFrame(video(u8(0, 0, 1, 2), 77), map, 'vp8')).toBe(false);
    });
    it('unknown codec: only frames that begin with a start code', () => {
        expect(isH26xFrame(video(u8(0, 0, 1, 2), undefined), new Map(), undefined)).toBe(true);
        expect(isH26xFrame(video(u8(0, 0, 0, 1, 2), undefined), new Map(), undefined)).toBe(true);
        expect(isH26xFrame(video(u8(0x9d, 1, 0x2a), undefined), new Map(), undefined)).toBe(false);
    });
    it('audio frames (no `type`) are never touched', () => {
        expect(isH26xFrame({ data: u8(0, 0, 1, 2).buffer, getMetadata: () => ({ payloadType: 103 }) }, map, 'h264')).toBe(false);
    });
    it('canonicalizeFrame rewrites in place and reports the layout', () => {
        const f = video(annexB([h264(0x41, 30, 9)], () => SC3), 103);
        expect(canonicalizeFrame(f)).toBe('short_start_code');
        expect(new Uint8Array(f.data)).toEqual(annexB([h264(0x41, 30, 9)], () => SC4));
        expect(canonicalizeFrame(f)).toBe('canonical');
    });
});

describe('installAnnexBCanonicalizer (wrapping LiveKit\'s worker onmessage)', () => {
    it('returns false and changes nothing without a LiveKit handler', () => {
        const scope = { onmessage: null, postMessage: () => {} };
        expect(installAnnexBCanonicalizer(scope)).toBe(false);
        expect(scope.onmessage).toBeNull();
    });

    it('passes every message to LiveKit; only encode streams get a stage in front', async () => {
        const seen: unknown[] = [];
        const scope = { onmessage: ((ev: MessageEvent) => { seen.push(ev.data); }) as ((ev: MessageEvent) => unknown) | null, postMessage: () => {} };
        expect(installAnnexBCanonicalizer(scope)).toBe(true);
        const decodeReadable = new ReadableStream();
        const msgs = [
            { kind: 'setKey', data: { keyIndex: 0 } },
            { kind: 'decode', data: { readableStream: decodeReadable, trackId: 'r' } },
            { kind: 'updateCodec', data: { trackId: 'cam', codec: 'h264', participantIdentity: 'me' } },
        ];
        for (const m of msgs) scope.onmessage!({ data: m } as MessageEvent);
        expect(seen).toEqual(msgs);
        expect((seen[1] as { data: { readableStream: unknown } }).data.readableStream).toBe(decodeReadable); // receiver untouched

        let ctl!: ReadableStreamDefaultController<EncodedFrameLike>;
        const encodeReadable = new ReadableStream<EncodedFrameLike>({ start(c) { ctl = c; } });
        scope.onmessage!({ data: { kind: 'encode', data: { readableStream: encodeReadable, trackId: 'cam', participantIdentity: 'me' } } } as MessageEvent);
        const forwarded = seen[3] as { kind: string; data: { readableStream: ReadableStream<EncodedFrameLike>; trackId: string } };
        expect(forwarded.kind).toBe('encode');
        expect(forwarded.data.trackId).toBe('cam');
        expect(forwarded.data.readableStream).not.toBe(encodeReadable);

        const frame: EncodedFrameLike = { data: ab(annexB([h264(0x41, 20, 1)], () => SC3)), type: 'delta', getMetadata: () => ({ payloadType: 103 }) };
        const audio = { data: u8(0, 0, 1, 7).buffer, getMetadata: () => ({}) } as EncodedFrameLike;
        ctl.enqueue(frame); ctl.enqueue(audio); ctl.close();
        const reader = forwarded.data.readableStream.getReader();
        const a = await reader.read(); const b = await reader.read();
        expect(new Uint8Array(a.value!.data)).toEqual(annexB([h264(0x41, 20, 1)], () => SC4)); // pinned h264 → canonical
        expect(new Uint8Array(b.value!.data)).toEqual(u8(0, 0, 1, 7)); // audio untouched
    });

    it('reports counts (only), the first window always and afterwards only when it rewrote something', async () => {
        const posted: { kind: string; data: Record<string, number> }[] = [];
        let t = 0;
        let out!: ReadableStream<EncodedFrameLike>;
        // Stand-in for LiveKit's handler: keeps the stream LiveKit would read.
        const liveKit = (ev: MessageEvent) => { out = (ev.data as { data: { readableStream: ReadableStream<EncodedFrameLike> } }).data.readableStream; };
        const scope = { onmessage: liveKit as ((ev: MessageEvent) => unknown) | null, postMessage: (m: unknown) => { posted.push(m as never); } };
        installAnnexBCanonicalizer(scope, () => t);
        let ctl!: ReadableStreamDefaultController<EncodedFrameLike>;
        const r = new ReadableStream<EncodedFrameLike>({ start(c) { ctl = c; } });
        scope.onmessage!({ data: { kind: 'encode', data: { readableStream: r, trackId: 'cam', codec: 'h265' } } } as MessageEvent);
        const reader = out.getReader();
        const push = async (sc: Uint8Array, type: string) => { ctl.enqueue({ data: ab(annexB([h265(1, 10, 3)], () => sc)), type, getMetadata: () => ({}) }); await reader.read(); };
        await push(SC4, 'delta');
        t += ANNEXB_STATS_EVERY_MS; await push(SC4, 'delta');
        expect(posted).toEqual([{ kind: ANNEXB_STATS_KIND, data: { frames: 2, rewritten: 0, shortStartCode: 0, leadingData: 0, keyRewritten: 0, deltaRewritten: 0 } }]);
        t += ANNEXB_STATS_EVERY_MS; await push(SC4, 'delta');
        expect(posted).toHaveLength(1); // nothing rewritten → silent after the first report
        await push(SC3, 'key');
        t += ANNEXB_STATS_EVERY_MS; await push(SC3, 'delta');
        expect(posted[1]).toEqual({ kind: ANNEXB_STATS_KIND, data: { frames: 3, rewritten: 2, shortStartCode: 2, leadingData: 0, keyRewritten: 1, deltaRewritten: 1 } });
    });
});

// ── The real cryptor ───────────────────────────────────────────────────────

function livekitWorkerSource(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'dist', 'livekit-client.e2ee.worker.mjs');
        if (existsSync(p)) return readFileSync(p, 'utf8');
        dir = dirname(dir);
    }
    throw new Error('livekit-client e2ee worker not found');
}

interface WorkerInstance { send(data: unknown): void; errors: string[]; scope: Record<string, unknown> }

/** One isolated instance of LiveKit's worker (its own globals, like a real Worker). */
function loadLiveKitWorker(code: string): WorkerInstance {
    const errors: string[] = [];
    const scope: Record<string, unknown> = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
        crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        ReadableStream, WritableStream, TransformStream, Uint8Array, ArrayBuffer, DataView, Map, Error, TypeError, Promise, Symbol, Math, Date,
        postMessage: (m: { kind?: string; data?: { error?: Error } }) => { if (m?.kind === 'error') errors.push(String(m.data?.error?.message)); },
    };
    scope.self = scope;
    vm.createContext(scope);
    vm.runInContext(code, scope);
    const handler = () => scope.onmessage as (ev: { data: unknown }) => void;
    return { send: data => handler()({ data }), errors, scope };
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const KEY_OPTS = { sharedKey: true, ratchetSalt: 'LKFrameEncryptionKey', ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 16, keySize: 128 };

class FakeFrame implements EncodedFrameLike {
    data: ArrayBuffer;
    type: 'key' | 'delta';
    timestamp: number;
    constructor(data: ArrayBuffer, type: 'key' | 'delta', timestamp: number) { this.data = data; this.type = type; this.timestamp = timestamp; }
    getMetadata() { return { synchronizationSource: 0x5eed, payloadType: 49 }; }
}

async function keyed(w: WorkerInstance, key: Uint8Array) {
    w.send({ kind: 'init', data: { keyProviderOptions: KEY_OPTS, loglevel: 'silent' } });
    const material = await crypto.subtle.importKey('raw', ab(key), 'HKDF', false, ['deriveBits', 'deriveKey']);
    w.send({ kind: 'setKey', data: { participantIdentity: 'pub', isPublisher: true, key: material, keyIndex: 0 } });
    w.send({ kind: 'enable', data: { enabled: true, participantIdentity: 'pub' } });
    await tick(30);
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
    for (let i = 0; i < 200 && out.length < frames.length; i++) await tick(5);
    await tick(30);
    return out;
}

async function roundTrip(frames: Uint8Array[], types: ('key' | 'delta')[], codec: 'h264' | 'h265', fix: boolean) {
    const code = livekitWorkerSource();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sender = loadLiveKitWorker(code);
    if (fix) expect(installAnnexBCanonicalizer(sender.scope as never)).toBe(true);
    await keyed(sender, key);
    sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec, participantIdentity: 'pub' } }); // E2EESenderCodecPin
    const enc = await pipe(sender, 'encode', 'cam', codec, frames.map((f, i) => new FakeFrame(ab(f), types[i], 1000 + i * 3000)));
    const receiver = loadLiveKitWorker(code);
    await keyed(receiver, key);
    const wire = enc.map(f => new FakeFrame(ab(overTheWire(new Uint8Array(f.data))), f.type, f.timestamp));
    const dec = await pipe(receiver, 'decode', 'cam-r', codec, wire);
    const byTs = new Map(dec.map(f => [f.timestamp, new Uint8Array(f.data)]));
    return {
        encrypted: enc.length,
        // Ciphertext really is ciphertext: the slice body never survives the sender.
        bodyInTheClear: enc.some((f, i) => Buffer.from(f.data).includes(Buffer.from(frames[i].subarray(frames[i].length - 16)))),
        delivered: frames.map((f, i) => {
            const got = byTs.get(1000 + i * 3000);
            return got ? Buffer.compare(Buffer.from(got), Buffer.from(overTheWire(f))) === 0 : false;
        }),
        receiverErrors: receiver.errors.length,
    };
}

describe('real livekit-client E2EE worker round trip (sender → WebRTC H.26x framing → receiver)', () => {
    const gop265 = (sc: (frame: number, nal: number) => Uint8Array) => [
        annexB([h265(32, 12, 1), h265(33, 30, 2), h265(34, 8, 3), h265(19, 400, 4)], i => sc(0, i)), // VPS SPS PPS IDR
        ...[1, 2, 3, 4].map(k => annexB([h265(1, 300, 10 + k)], i => sc(k, i))), // TRAIL_R
    ];
    const gop264 = (sc: (frame: number, nal: number) => Uint8Array) => [
        annexB([h264(0x67, 20, 1), h264(0x68, 6, 2), h264(0x65, 400, 3)], i => sc(0, i)), // SPS PPS IDR
        ...[1, 2, 3, 4].map(k => annexB([h264(0x41, 300, 10 + k)], i => sc(k, i))), // non-IDR slice
    ];
    const types: ('key' | 'delta')[] = ['key', 'delta', 'delta', 'delta', 'delta'];
    // The field layout: keyframes all 4-byte, delta frames with a 3-byte start code.
    const deltasShort = (frame: number) => (frame === 0 ? SC4 : SC3);

    for (const [codec, gop] of [['h265', gop265], ['h264', gop264]] as const) {
        it(`${codec}: all 4-byte start codes round-trip with or without the hook (control)`, async () => {
            for (const fix of [false, true]) {
                const r = await roundTrip(gop(() => SC4), types, codec, fix);
                expect(r.delivered).toEqual([true, true, true, true, true]);
                expect(r.bodyInTheClear).toBe(false);
            }
        });

        it(`${codec}: 3-byte start codes on delta frames — WITHOUT the hook only the keyframe survives (the bug)`, async () => {
            const r = await roundTrip(gop(deltasShort), types, codec, false);
            expect(r.encrypted).toBe(5);
            expect(r.delivered).toEqual([true, false, false, false, false]);
            expect(r.receiverErrors).toBeGreaterThan(0); // GCM authentication failures
        });

        it(`${codec}: 3-byte start codes — WITH the hook every frame survives, still encrypted`, async () => {
            for (const sc of [deltasShort, () => SC3, (_f: number, nal: number) => (nal === 0 ? SC4 : SC3)]) {
                const r = await roundTrip(gop(sc), types, codec, true);
                expect(r.delivered).toEqual([true, true, true, true, true]);
                expect(r.bodyInTheClear).toBe(false);
                expect(r.receiverErrors).toBe(0);
            }
        });
    }

    it('a receiver with the wrong key still decrypts nothing (the hook never weakens encryption)', async () => {
        const code = livekitWorkerSource();
        const sender = loadLiveKitWorker(code);
        installAnnexBCanonicalizer(sender.scope as never);
        await keyed(sender, crypto.getRandomValues(new Uint8Array(32)));
        sender.send({ kind: 'updateCodec', data: { trackId: 'cam', codec: 'h265', participantIdentity: 'pub' } });
        const frames = gop265(() => SC3);
        const enc = await pipe(sender, 'encode', 'cam', 'h265', frames.map((f, i) => new FakeFrame(ab(f), types[i], 1000 + i * 3000)));
        const receiver = loadLiveKitWorker(code);
        await keyed(receiver, crypto.getRandomValues(new Uint8Array(32)));
        const dec = await pipe(receiver, 'decode', 'cam-r', 'h265', enc.map(f => new FakeFrame(ab(overTheWire(new Uint8Array(f.data))), f.type, f.timestamp)));
        expect(enc).toHaveLength(5);
        expect(dec).toHaveLength(0);
    });
});

describe('wiring', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    it('the call\'s E2EE worker is LiveKit\'s worker with the canonicalizer installed after it', () => {
        const w = readFileSync(join(here, '..', 'workers', 'e2eeWorker.ts'), 'utf8');
        const lk = w.indexOf("import 'livekit-client/e2ee-worker'");
        const hook = w.indexOf('installAnnexBCanonicalizer(self');
        expect(lk).toBeGreaterThan(-1);
        expect(hook).toBeGreaterThan(lk);
    });
    it('CallPane builds the room\'s E2EE worker from workers/e2eeWorker, not the bare LiveKit worker', () => {
        const pane = readFileSync(join(here, '..', 'components', 'CallPane.tsx'), 'utf8');
        expect(pane).toMatch(/import e2eeWorkerUrl from '\.\.\/workers\/e2eeWorker\?worker&url'/);
        expect(pane).not.toMatch(/livekit-client\/e2ee-worker\?worker/);
        expect(pane).toMatch(/new Worker\(e2eeWorkerUrl, \{ type: 'module' \}\)/);
        expect(pane).toMatch(/encryption: stableE2EEOptions\(\s*keyProvider,\s*makeE2EEWorker\(\),/);
    });
});
