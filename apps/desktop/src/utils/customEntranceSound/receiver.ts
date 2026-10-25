/**
 * The receiving half of the in-call transfer, free of LiveKit and React (the
 * hook in components/call/EntranceSoundTransport.tsx feeds it packets), so
 * every rule is unit-tested:
 *
 *   1. structure (./wire.ts parseHeader) and a per-sender rate limit, before
 *      any crypto: a flood costs a map lookup;
 *   2. an id we already hold is not decrypted again;
 *   3. no call key -> nothing is accepted;
 *   4. each chunk must authenticate (AES-GCM; AAD = id, index, total, sender);
 *   5. bounded reassembly (./assembler.ts);
 *   6. the whole: size cap, WebM magic, SHA-256 prefix == the advertised id,
 *      AND that id == the one in the sender's server personalization
 *      (`custom:<id>`), so nobody can push a sound for someone who did not
 *      choose it;
 *   7. it must decode, and its listener gain is measured from the decode
 *      (./playbackGain.ts);
 * only then is it cached (./receivedCache.ts). Any failure: no sound.
 */

import { PerSenderRateLimiter } from '../annotationRate';
import { SoundAssembler } from './assembler';
import { checkSoundBytes } from './identity';
import { listenerGain } from './playbackGain';
import type { ReceivedSoundCache } from './receivedCache';
import { openPacket, parseHeader } from './wire';

/** Per sender: a whole sound is <= 8 packets; allow a couple in a burst, ~1 a second after. */
export const RECEIVE_RATE = { perSecond: 1, burst: 24 };

export type ReceiveOutcome =
    | 'not-ours' | 'rate' | 'have' | 'no-key' | 'auth' | 'pending' | 'duplicate' | 'bounds'
    | 'invalid' | 'not-expected' | 'undecodable' | 'stored';

export interface DecodedAudio { channels: Float32Array[]; sampleRate: number }

export interface ReceiverDeps {
    /** The entrance-sound key for the current call key, or null (no key: accept nothing). */
    key(): Promise<CryptoKey | null>;
    /** The content id the sender's server personalization advertises (`custom:<id>` -> id), or null. */
    expectedId(sender: string): Promise<string | null>;
    /** WebAudio decode; null when it does not decode. */
    decode(bytes: Uint8Array): Promise<DecodedAudio | null>;
    cache: ReceivedSoundCache;
    now?: () => number;
}

export class EntranceSoundReceiver {
    private readonly limiter = new PerSenderRateLimiter(RECEIVE_RATE);
    private readonly assembler: SoundAssembler;
    private readonly deps: ReceiverDeps;
    private readonly now: () => number;

    constructor(deps: ReceiverDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
        this.assembler = new SoundAssembler({ now: this.now });
    }

    async onPacket(sender: string, payload: Uint8Array): Promise<ReceiveOutcome> {
        if (!sender) return 'not-ours';
        const h = parseHeader(payload);
        if (!h) return 'not-ours';
        if (!this.limiter.allow(sender, this.now())) return 'rate';
        if (this.deps.cache.has(h.id)) return 'have';
        const key = await this.deps.key();
        if (!key) return 'no-key';
        const opened = await openPacket(key, payload, sender);
        if (!opened) return 'auth';
        const res = this.assembler.push(sender, opened.header, opened.chunk);
        if (res.status === 'pending') return 'pending';
        if (res.status === 'duplicate') return 'duplicate';
        if (res.status === 'rejected') return 'bounds';
        if (this.deps.cache.has(res.id)) return 'have';
        if (await checkSoundBytes(res.bytes, res.id)) return 'invalid';
        let expected: string | null = null;
        try { expected = await this.deps.expectedId(sender); } catch { expected = null; }
        if (expected !== res.id) return 'not-expected';
        let decoded: DecodedAudio | null = null;
        try { decoded = await this.deps.decode(res.bytes); } catch { decoded = null; }
        if (!decoded || decoded.channels.length === 0 || decoded.channels[0].length === 0) return 'undecodable';
        const gain = listenerGain(decoded.channels, decoded.sampleRate);
        if (!(gain > 0)) return 'undecodable';
        this.deps.cache.put(res.id, res.bytes, gain);
        return 'stored';
    }

    /** A participant left. */
    forget(sender: string): void {
        this.assembler.forget(sender);
        this.limiter.forget(sender);
    }

    reset(): void { this.assembler.clear(); }
}
