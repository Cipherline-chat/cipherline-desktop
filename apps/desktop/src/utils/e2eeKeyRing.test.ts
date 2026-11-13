/**
 * The key ring (utils/e2eeKeyRing.ts): rotation without a decrypt gap.
 *
 * Two layers:
 *   1. pure helpers + provider behaviour (which slot, who sends at what index,
 *      the grace drop, the legacy fallback);
 *   2. a REAL-CRYPTO two-peer proof: LiveKit's own `FrameCryptor` +
 *      `ParticipantKeyHandler` (the exact classes the E2EE worker runs,
 *      imported from the installed livekit-client source, same trick as
 *      e2eeSenderCodec.test.ts) seal and open real AES-GCM frames across
 *      several rotations. Each peer's provider emits SetKey exactly as the
 *      real E2EEManager would receive it, and the worker side applies it with
 *      the worker's own `setSharedKey` semantics. Key delivery to the second
 *      peer lags, as in a call (poll → ACK → decrypt → effect).
 *      A NEGATIVE control runs the OLD behaviour (the stock
 *      `ExternalE2EEKeyProvider`, index-0 overwrite) through the same harness
 *      and must reproduce the InvalidKey failures.
 *
 * Timings are scaled down (rotation 600 ms instead of 10 min, switch delay
 * 150 ms, key-delivery lag <= 25 ms); the production constants are not
 * touched and are pinned by their own test below.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalE2EEKeyProvider, KeyProviderEvent } from 'livekit-client';
import {
    KEYRING_ATTR, KEYRING_PREV_KEY_GRACE_MS, KEYRING_SEND_SWITCH_DELAY_MS, RotatingKeyProvider,
    allRemotesRingCapable, epochForKey, ringIndexForEpoch,
} from './e2eeKeyRing';
import { installE2EEKey } from './e2eeActivation';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const keyB64 = (seed: number) => {
    const b = new Uint8Array(32).map((_, i) => (seed * 37 + i * 11) & 0xff);
    return btoa(String.fromCharCode(...b));
};
const keyBuf = (seed: number) => {
    const bin = atob(keyB64(seed));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer as ArrayBuffer;
};

describe('pure helpers and constants', () => {
    it('ring slots are 1..15, never 0, and consecutive epochs never share a slot', () => {
        const seen = new Set<number>();
        for (let e = 1; e <= 200; e++) {
            const i = ringIndexForEpoch(e);
            expect(i).toBeGreaterThanOrEqual(1);
            expect(i).toBeLessThanOrEqual(15);
            expect(i).not.toBe(ringIndexForEpoch(e + 1));
            seen.add(i);
        }
        expect(seen.size).toBe(15);
    });
    it('production constants: 3 s switch delay, 30 s grace (rotation itself stays 10 min in callKeyStore)', () => {
        expect(KEYRING_SEND_SWITCH_DELAY_MS).toBe(3_000);
        expect(KEYRING_PREV_KEY_GRACE_MS).toBe(30_000);
    });
    it('allRemotesRingCapable: absent / other value = legacy; vacuously true when alone', () => {
        const cap = { attributes: { [KEYRING_ATTR]: '1' } };
        expect(allRemotesRingCapable([])).toBe(true);
        expect(allRemotesRingCapable([cap, cap])).toBe(true);
        expect(allRemotesRingCapable([cap, { attributes: {} }])).toBe(false);
        expect(allRemotesRingCapable([cap, {}])).toBe(false);
        expect(allRemotesRingCapable([{ attributes: { [KEYRING_ATTR]: '0' } }])).toBe(false);
    });
    it('epochForKey only trusts the store when it holds THIS key at epoch >= 1', () => {
        expect(epochForKey({ keyB64: 'a', epoch: 3 }, 'a')).toBe(3);
        expect(epochForKey({ keyB64: 'a', epoch: 3 }, 'b')).toBeUndefined();
        expect(epochForKey({ keyB64: 'a', epoch: 0 }, 'a')).toBeUndefined();
        expect(epochForKey(null, 'a')).toBeUndefined();
    });
});

// ── Harness: the worker side of one peer ────────────────────────────────────
function livekitPath(rel: string): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'src', rel);
        if (existsSync(p)) return p;
        dir = dirname(dir);
    }
    throw new Error(`livekit-client source not found: ${rel}`);
}
const loadWorkerParts = async () => {
    const fc: any = await import(/* @vite-ignore */ livekitPath('e2ee/worker/FrameCryptor.ts'));
    const kh: any = await import(/* @vite-ignore */ livekitPath('e2ee/worker/ParticipantKeyHandler.ts'));
    const ev: any = await import(/* @vite-ignore */ livekitPath('e2ee/events.ts'));
    return { FrameCryptor: fc.FrameCryptor, encryptionEnabledMap: fc.encryptionEnabledMap, ParticipantKeyHandler: kh.ParticipantKeyHandler, CryptorEvent: ev.CryptorEvent };
};

interface Frame { data: ArrayBuffer; timestamp: number; getMetadata(): { synchronizationSource: number } }

class Peer {
    readonly handler: any;
    readonly errors: string[] = [];
    readonly sent: Uint8Array[] = [];
    readonly sentIndex: number[] = [];
    readonly got: Uint8Array[] = [];
    private ts = 1000;
    private queue: Promise<unknown> = Promise.resolve();
    private encIn!: ReadableStreamDefaultController<Frame>;
    private decIn!: ReadableStreamDefaultController<Frame>;
    peer: Peer | null = null;

    readonly id: string;
    readonly provider: ExternalE2EEKeyProvider;
    constructor(id: string, provider: ExternalE2EEKeyProvider, parts: any) {
        this.id = id;
        this.provider = provider;
        this.handler = new parts.ParticipantKeyHandler('shared-key', provider.getOptions());
        // E2EEManager.postKey → worker 'setKey' → setSharedKey(key, keyIndex, updateCurrentKeyIndex), serialised.
        provider.on(KeyProviderEvent.SetKey, (info: any, update: boolean) => {
            this.queue = this.queue.then(() => this.handler.setKey(info.key, info.keyIndex, update ?? true));
        });
        const opts = provider.getOptions();
        parts.encryptionEnabledMap.set(`${id}-enc`, true);
        parts.encryptionEnabledMap.set(`${id}-dec`, true);
        const enc = new parts.FrameCryptor({ participantIdentity: `${id}-enc`, keys: this.handler, keyProviderOptions: opts, sifTrailer: new Uint8Array() });
        const dec = new parts.FrameCryptor({ participantIdentity: `${id}-dec`, keys: this.handler, keyProviderOptions: opts, sifTrailer: new Uint8Array() });
        dec.on(parts.CryptorEvent.Error, (e: any) => this.errors.push(String(e?.reason)));
        enc.setupTransform('encode', new ReadableStream<Frame>({ start: c => { this.encIn = c; } }) as any,
            new WritableStream<Frame>({ write: f => {
                const bytes = new Uint8Array(f.data);
                this.sentIndex.push(bytes[bytes.length - 1]);
                this.peer?.receiveRaw(f);
            } }) as any, `${id}-t`);
        dec.setupTransform('decode', new ReadableStream<Frame>({ start: c => { this.decIn = c; } }) as any,
            new WritableStream<Frame>({ write: f => { this.got.push(new Uint8Array(f.data)); } }) as any, `${id}-r`);
    }

    /** Key arrives at the APP layer (after the call_key poll/ACK/decrypt pipeline) and is installed. */
    async deliverKey(seed: number, epoch?: number) {
        await installE2EEKey(this.provider as any, keyB64(seed), epoch);
    }
    send() {
        // Opus-like audio frame: 1 clear TOC byte + a unique payload.
        const payload = new Uint8Array(40);
        crypto.getRandomValues(payload);
        payload[0] = 0xfc;
        this.sent.push(payload);
        this.ts += 960;
        this.encIn.enqueue({ data: payload.slice().buffer, timestamp: this.ts, getMetadata: () => ({ synchronizationSource: 4242 }) });
    }
    receiveRaw(f: Frame) { this.decIn.enqueue({ data: f.data.slice(0), timestamp: f.timestamp, getMetadata: () => ({ synchronizationSource: 4242 }) }); }
}

/** Number of frames peer `to` decrypted back to exactly what `from` sent. */
const delivered = (from: Peer, to: Peer) => {
    const want = new Set(from.sent.map(p => Array.from(p).join(',')));
    return to.got.filter(g => want.has(Array.from(g).join(','))).length;
};

async function pump(a: Peer, b: Peer, ms: number, everyMs = 4) {
    const end = Date.now() + ms;
    while (Date.now() < end) { a.send(); b.send(); await sleep(everyMs); }
}

describe('REAL FrameCryptor across rotations (two peers, key delivery lags)', () => {
    const providers: RotatingKeyProvider[] = [];
    afterEach(() => { for (const p of providers.splice(0)) p.dispose(); });

    const ring = () => { const p = new RotatingKeyProvider({ switchDelayMs: 150, graceMs: 300 }); providers.push(p); return p; };
    const ROT_MS = 600;

    it('ring peers: 4 epochs (3 rotations), every frame in both directions decrypts, zero InvalidKey', async () => {
        const parts = await loadWorkerParts();
        const pa = ring(), pb = ring();
        const A = new Peer('A', pa, parts), B = new Peer('B', pb, parts);
        A.peer = B; B.peer = A;
        // Both advertise (attributes landed) → indexed sending.
        pa.setPeersCapable(true); pb.setPeersCapable(true);
        await Promise.all([A.deliverKey(1, 1), B.deliverKey(1, 1)]);
        await sleep(200); // let the first switch happen

        const lags = [25, 10, 20];
        for (let epoch = 2; epoch <= 4; epoch++) {
            // The rotator (A) installs when it broadcasts; B only after its pipeline lag.
            await A.deliverKey(epoch, epoch);
            const lag = lags[epoch - 2];
            const bDone = sleep(lag).then(() => B.deliverKey(epoch, epoch));
            await pump(A, B, ROT_MS);
            await bDone;
        }
        await sleep(150); // drain the streams

        const stats = {
            sentA: A.sent.length, gotByB: delivered(A, B), sentB: B.sent.length, gotByA: delivered(B, A),
            errorsA: A.errors.length, errorsB: B.errors.length, indicesA: [...new Set(A.sentIndex)].sort((x, y) => x - y),
        };
        console.log('[ring] ' + JSON.stringify(stats));
        expect(stats.gotByB).toBe(stats.sentA);
        expect(stats.gotByA).toBe(stats.sentB);
        expect(stats.errorsA).toBe(0);
        expect(stats.errorsB).toBe(0);
        // It really used the ring (several distinct non-zero slots), not index 0.
        expect(stats.indicesA.filter(i => i !== 0).length).toBeGreaterThanOrEqual(3);
    }, 20_000);

    it('NEGATIVE CONTROL: the old behaviour (stock ExternalE2EEKeyProvider, index-0 overwrite) fails the same scenario', async () => {
        const parts = await loadWorkerParts();
        const A = new Peer('A', new ExternalE2EEKeyProvider(), parts), B = new Peer('B', new ExternalE2EEKeyProvider(), parts);
        A.peer = B; B.peer = A;
        await Promise.all([A.deliverKey(1), B.deliverKey(1)]);
        for (let epoch = 2; epoch <= 4; epoch++) {
            await A.deliverKey(epoch);
            const bDone = sleep(25).then(() => B.deliverKey(epoch));
            await pump(A, B, ROT_MS);
            await bDone;
        }
        await sleep(150);
        const stats = {
            sentA: A.sent.length, gotByB: delivered(A, B), sentB: B.sent.length, gotByA: delivered(B, A),
            errorsA: A.errors.length, errorsB: B.errors.length,
        };
        console.log('[old] ' + JSON.stringify(stats));
        expect(stats.errorsA + stats.errorsB).toBeGreaterThan(0);                       // InvalidKey reproduced
        expect(stats.gotByB).toBeLessThan(stats.sentA);                                  // frames lost
        expect(stats.gotByA).toBeLessThan(stats.sentB);
    }, 20_000);

    it('mixed call: a legacy peer (index-0 only) keeps decrypting a ring peer that has been told it is not alone', async () => {
        const parts = await loadWorkerParts();
        const pa = ring();
        const A = new Peer('A', pa, parts), L = new Peer('L', new ExternalE2EEKeyProvider(), parts);
        A.peer = L; L.peer = A;
        // L advertises nothing → A's roster verdict stays false (the default).
        expect(allRemotesRingCapable([{ attributes: {} }])).toBe(false);
        pa.setPeersCapable(false);
        await Promise.all([A.deliverKey(1, 1), L.deliverKey(1)]);
        await pump(A, L, 120);
        await Promise.all([A.deliverKey(2, 2), L.deliverKey(2)]); // simultaneous: only the compatibility is under test
        await sleep(60);                                          // let both workers apply the key
        // (Frames sealed WHILE a legacy peer overwrites index 0 can still fail — that is today's
        // behaviour for a call containing a legacy participant and is out of our hands. Count
        // from here, once both sides hold epoch 2.)
        const fromA = A.sent.length, fromL = L.sent.length, gotL = delivered(A, L), gotA = delivered(L, A);
        await pump(A, L, 300);
        await sleep(100);
        expect(new Set(A.sentIndex)).toEqual(new Set([0]));        // never stamps a slot the legacy peer lacks
        expect(delivered(A, L) - gotL).toBe(A.sent.length - fromA);
        expect(delivered(L, A) - gotA).toBe(L.sent.length - fromL);
    }, 20_000);

    it('a legacy participant joins mid-call: sender drops back to index 0 at once, and the joiner (key at index 0 only) decrypts', async () => {
        const parts = await loadWorkerParts();
        const pa = ring(), pb = ring();
        const A = new Peer('A', pa, parts), B = new Peer('B', pb, parts);
        A.peer = B; B.peer = A;
        pa.setPeersCapable(true); pb.setPeersCapable(true);
        await Promise.all([A.deliverKey(1, 1), B.deliverKey(1, 1)]);
        await Promise.all([A.deliverKey(2, 2), B.deliverKey(2, 2)]);
        await sleep(250);
        expect(pa.currentSendIndex).toBe(ringIndexForEpoch(2));
        // Legacy L joins (attribute absent) → A and B fall back; L got epoch 2 at index 0.
        const L = new Peer('L', new ExternalE2EEKeyProvider(), parts);
        await L.deliverKey(2);
        pa.setPeersCapable(false); pb.setPeersCapable(false);
        expect(pa.currentSendIndex).toBe(0);
        A.peer = L; L.peer = A;
        await sleep(40);               // the worker applies the SetKey message (a few ms), then count
        A.sentIndex.length = 0; A.sent.length = 0;
        await pump(A, L, 200);
        await sleep(100);
        expect(new Set(A.sentIndex)).toEqual(new Set([0]));
        expect(delivered(A, L)).toBe(A.sent.length);
        expect(L.errors.length).toBe(0);
        // The slot invariant that makes any peer's flip safe: every epoch also sits at index 0.
        expect(pb.heldIndices()).toContain(0);
        expect(pb.heldIndices()).toContain(ringIndexForEpoch(2));
    }, 20_000);

    it('the previous epoch decrypts during the grace and is dropped after it', async () => {
        const parts = await loadWorkerParts();
        const pa = ring(), pb = ring();
        const A = new Peer('A', pa, parts), B = new Peer('B', pb, parts);
        A.peer = B; B.peer = A;
        pa.setPeersCapable(true); pb.setPeersCapable(true);
        await Promise.all([A.deliverKey(1, 1), B.deliverKey(1, 1)]);
        await sleep(200);
        // A sealed one frame under epoch 1 (slot 2), captured raw.
        const oldFrames: Frame[] = [];
        const realReceive = B.receiveRaw.bind(B);
        B.receiveRaw = (f: Frame) => { oldFrames.push({ ...f, data: f.data.slice(0) }); realReceive(f); };
        A.send();
        await sleep(60);
        expect(oldFrames.length).toBe(1);
        expect(new Uint8Array(oldFrames[0].data).at(-1)).toBe(ringIndexForEpoch(1));
        const before = B.got.length;
        expect(before).toBe(1);

        await Promise.all([A.deliverKey(2, 2), B.deliverKey(2, 2)]);
        expect(pb.heldIndices()).toEqual([0, ringIndexForEpoch(1), ringIndexForEpoch(2)].sort((x, y) => x - y));
        // Inside the grace: a straggler sealed under epoch 1 still opens.
        realReceive(oldFrames[0]);
        await sleep(60);
        expect(B.got.length).toBe(before + 1);
        // After the grace: epoch 1's slot is gone and the same frame no longer opens.
        await sleep(400);
        expect(pb.heldIndices()).not.toContain(ringIndexForEpoch(1));
        expect(pa.heldIndices()).not.toContain(ringIndexForEpoch(1));
        const errs = B.errors.length;
        realReceive(oldFrames[0]);
        await sleep(80);
        expect(B.got.length).toBe(before + 1);
        expect(B.errors.length).toBeGreaterThan(errs);
    }, 20_000);
});

describe('RotatingKeyProvider wiring', () => {
    it('legacy setKey() = index 0, sending index 0 (Calls channels, epoch-less keys, first key)', async () => {
        const p = new RotatingKeyProvider();
        const seen: Array<[number | undefined, boolean]> = [];
        p.on(KeyProviderEvent.SetKey, (info: any, upd: boolean) => seen.push([info.keyIndex, upd]));
        await p.setKey(keyBuf(1));
        expect(p.getKeys()).toHaveLength(1);
        expect(p.currentSendIndex).toBe(0);
        expect(seen).toEqual([[0, true]]);
        expect(p.ringCapable).toBe(false); // no epoch → not advertised
        p.dispose();
    });

    it('with no ring-capable peers the new key goes live at index 0 immediately (== old behaviour) and never moves the sender to a slot', async () => {
        const p = new RotatingKeyProvider({ switchDelayMs: 30, graceMs: 1000 });
        await p.installKeyAtEpoch(keyBuf(1), 1);
        await p.installKeyAtEpoch(keyBuf(2), 2);
        await sleep(80);
        expect(p.currentSendIndex).toBe(0);
        expect(p.ringCapable).toBe(true);   // we still advertise, so that others may go indexed
        p.dispose();
    });

    it('installs the new epoch non-current, then moves the send index only after the delay', async () => {
        const p = new RotatingKeyProvider({ switchDelayMs: 80, graceMs: 1000 });
        p.setPeersCapable(true);
        await p.installKeyAtEpoch(keyBuf(1), 1);
        await sleep(120);
        expect(p.currentSendIndex).toBe(ringIndexForEpoch(1));
        const events: Array<[number | undefined, boolean]> = [];
        p.on(KeyProviderEvent.SetKey, (info: any, upd: boolean) => events.push([info.keyIndex, upd]));
        await p.installKeyAtEpoch(keyBuf(2), 2);
        expect(p.currentSendIndex).toBe(ringIndexForEpoch(1));          // not yet
        expect(events.every(([, upd]) => upd === false)).toBe(true);    // slot + legacy slot both non-current
        await sleep(160);
        expect(p.currentSendIndex).toBe(ringIndexForEpoch(2));
        p.dispose();
    });

    it('a stale or duplicate epoch never rolls the ring back', async () => {
        const p = new RotatingKeyProvider({ switchDelayMs: 10, graceMs: 1000 });
        p.setPeersCapable(true);
        await p.installKeyAtEpoch(keyBuf(5), 5);
        await p.installKeyAtEpoch(keyBuf(4), 4);
        await p.installKeyAtEpoch(keyBuf(5), 5);
        expect(p.newestEpoch).toBe(5);
        expect(p.heldIndices()).toEqual([0, ringIndexForEpoch(5)].sort((a, b) => a - b));
        p.dispose();
    });

    it('a peer going legacy mid-call moves the sender to index 0 immediately; going back waits out the remaining delay', async () => {
        const p = new RotatingKeyProvider({ switchDelayMs: 60, graceMs: 1000 });
        p.setPeersCapable(true);
        await p.installKeyAtEpoch(keyBuf(1), 1);
        await sleep(100);
        expect(p.currentSendIndex).toBe(ringIndexForEpoch(1));
        p.setPeersCapable(false);
        expect(p.currentSendIndex).toBe(0);
        p.setPeersCapable(true);            // installed > delay ago: immediate
        await sleep(5);
        expect(p.currentSendIndex).toBe(ringIndexForEpoch(1));
        p.dispose();
    });

    it('SignalConnected re-post: the manager marks "current" by getLatestManuallySetKeyIndex, which follows the send index', async () => {
        const p = new RotatingKeyProvider({ switchDelayMs: 10, graceMs: 1000 });
        p.setPeersCapable(true);
        await p.installKeyAtEpoch(keyBuf(1), 1);
        await sleep(40);
        const latest = p.getLatestManuallySetKeyIndex();
        const cur = p.getKeys().filter((k: any) => (k.keyIndex ?? 0) === latest);
        expect(cur).toHaveLength(1);
        expect(latest).toBe(ringIndexForEpoch(1));
        p.dispose();
    });
});

describe('installE2EEKey epoch routing', () => {
    it('with an epoch and a ring provider: installs at the slot; without: the legacy setKey path', async () => {
        const calls: string[] = [];
        const inst = {
            getKeys: () => [{}],
            setKey: async () => { calls.push('setKey'); },
            installKeyAtEpoch: async (_k: ArrayBuffer, e: number) => { calls.push(`epoch:${e}`); },
        };
        await installE2EEKey(inst, keyB64(1), 7);
        await installE2EEKey(inst, keyB64(1));
        const plain = { getKeys: () => [{}], setKey: async () => { calls.push('plain'); } };
        await installE2EEKey(plain, keyB64(1), 7); // provider without the ring: epoch ignored
        expect(calls).toEqual(['epoch:7', 'setKey', 'plain']);
    });
});
