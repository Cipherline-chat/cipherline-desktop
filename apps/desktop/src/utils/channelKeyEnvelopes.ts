/**
 * Pure helpers for pulling and acknowledging channel-key envelopes
 * (Dashboard.pullChannelKeysOnce).
 *
 * Three defects lived in that loop, found while chasing 60,125 / 5,436
 * "key_decrypt_failed" beta events from two established members
 * (2026-10-17). They fed each other:
 *
 *  1. THE ACK NEVER LANDED. GET channel-keys/pending returns every unacked
 *     envelope in one go; the client then POSTed ALL the ids it had handled
 *     in a single channel-keys/ack. The API caps that body at 200 ids
 *     (AckKeyEnvelopesDto, @ArrayMaxSize(200), since 2026-09-14), so any pull
 *     of more than 200 envelopes — a device that was offline for a few
 *     rotations, a server with 30 channels x 20 epochs — drew a 400 that the
 *     caller swallowed. Nothing was acked, so (a) the whole backlog came back
 *     on the next pull, and (b) a key request is only marked fulfilled by an
 *     ack, so it stayed open and every online holder kept re-serving it.
 *     Measured server-side: 627,463 envelopes for ONE device in 7 days across
 *     508 distinct (channel, epoch) pairs — ~1,200 copies of each.
 *
 *  2. THE REPLAYS WERE TREATED AS A KEY PROBLEM. Every one of those redelivered
 *     envelopes was a genuine replay by then (the first copy was decrypted and
 *     its key installed; the engine keeps the one-time ephemeral key and
 *     refuses the second use). Each cost three more pulls and a fresh key
 *     request before the give-up bound acked it, and was reported as a decrypt
 *     failure: 59,467 REPLAY events from a single device in a day.
 *
 *  3. A HELD-BACK ENVELOPE WAS DESTROYED. When the distributor check could not
 *     decide yet (roster/viewer data possibly stale) or an epoch conflict was
 *     unresolved, the loop `continue`d without acking so a later pull could
 *     finish the job — but the envelope had already been DECRYPTED, and a
 *     decrypt consumes its ephemeral key. The later pull therefore hit REPLAY
 *     and the key it carried was gone for good, until a holder happened to be
 *     asked again. HeldBackEnvelopes keeps the already-decrypted content for a
 *     few minutes so the follow-up pull finishes the install it deferred.
 */

import { extractE2eeCode } from './e2eeErrors';

/** The API's cap on one channel-keys/ack body (AckKeyEnvelopesDto @ArrayMaxSize). */
export const CHANNEL_KEY_ACK_BATCH_MAX = 200;

export function chunkIds<T>(ids: readonly T[], size: number = CHANNEL_KEY_ACK_BATCH_MAX): T[][] {
    const n = Math.max(1, Math.floor(size));
    const out: T[][] = [];
    for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n) as T[]);
    return out;
}

export interface AckOutcome {
    /** Ids whose batch the server accepted. */
    acked: number;
    /** Ids in batches that failed — they stay unacked and come back on the next pull. */
    failed: number;
}

/**
 * Ack `ids` in batches the API accepts. Every batch is independent: one that
 * fails (a 429, a network blip) must not strand the batches after it, which is
 * what a single oversized POST did to the whole backlog. Never throws.
 */
export async function ackInBatches(
    ids: readonly string[],
    post: (batch: string[]) => Promise<unknown>,
    size: number = CHANNEL_KEY_ACK_BATCH_MAX,
): Promise<AckOutcome> {
    const unique = [...new Set(ids)];
    let acked = 0;
    let failed = 0;
    for (const batch of chunkIds(unique, size)) {
        try {
            await post(batch);
            acked += batch.length;
        } catch {
            failed += batch.length;
        }
    }
    return { acked, failed };
}

/**
 * The order a pull installs envelopes in: every channel's NEWEST epoch first
 * (all channels), then the rest newest-first. `newestCount` is how many lead
 * the list — the pull acks those before starting on history, so each request
 * closes (and holders that have not sent its newest stand down) as soon as the
 * keys that make the channel usable are in, not after the whole backlog.
 *
 * 2026-10-20: a joiner on a slower machine acked in waves at +4, +8, +15, +32,
 * +104 and +200 s — one wave per pull, each pull ~0.5 s per envelope — and the
 * API returns the backlog ordered by epoch number across ALL channels, so one
 * channel's history (epoch 20) came before another channel's newest (epoch 4).
 * Holders saw the requests open for the whole time and kept answering them.
 */
export function orderEnvelopesForInstall<T extends { channel_id: string; epoch: number }>(
    envelopes: readonly T[],
): { ordered: T[]; newestCount: number } {
    const newestOf = new Map<string, number>();
    for (const e of envelopes) newestOf.set(e.channel_id, Math.max(newestOf.get(e.channel_id) ?? -Infinity, e.epoch));
    const newest: T[] = [];
    const rest: T[] = [];
    for (const e of envelopes) (e.epoch === newestOf.get(e.channel_id) ? newest : rest).push(e);
    // Stable within each group: the API's own order (epoch DESC, newest copy first).
    rest.sort((a, b) => b.epoch - a.epoch);
    return { ordered: [...newest, ...rest], newestCount: newest.length };
}

/**
 * True when an envelope failed because its one-time ephemeral key was already
 * used — i.e. this very envelope has been decrypted before. Retrying can never
 * change that (e2eeErrors lists REPLAY as permanent), so the loop acks it
 * straight away instead of burning three more pulls on it.
 */
export function isEnvelopeReplay(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    return extractE2eeCode(msg) === 'REPLAY';
}

/**
 * What to do with a channel-key envelope that failed to decrypt as a REPLAY.
 *  - We hold the key for that epoch: the first copy did its job. Ack, say
 *    nothing — it is a redelivery, not a failure.
 *  - We do not: the first decrypt did NOT end in an install (a crash, or a
 *    deferred install that was lost). Nothing in this envelope can ever help,
 *    but the key is still needed — ack it (so it stops coming back) and ask
 *    the holders for a fresh envelope.
 * Either way the envelope is acked: acking only tells the server to stop
 * serving ciphertext that can never be opened, it accepts no key.
 */
export function decideReplayEnvelope(heldEpochKey: boolean): { ack: true; report: boolean; reask: boolean } {
    return { ack: true, report: !heldEpochKey, reask: !heldEpochKey };
}

export interface HeldDecrypt {
    /** The ciphertext this content was decrypted from — a reuse must match it exactly. */
    ciphertext_b64: string;
    at: number;
}

/**
 * In-memory, short-lived store of envelopes that were decrypted but whose
 * install was deliberately deferred. Single-use (`take` removes), bounded,
 * expiring, never persisted, never put in React state.
 *
 * Security: the content is exactly what the install path was already holding in
 * a local variable moments earlier; this only stretches that to the follow-up
 * pull. Nothing is trusted that was not trusted before — a reused entry is
 * run back through the SAME checks (envelope binding, distributor pin and
 * authorisation, fingerprint arbitration) before `setChannelKey`, and it is
 * only reused for the byte-identical ciphertext it came from, so a server that
 * swaps the ciphertext under the same envelope id gets a normal decrypt.
 */
export class HeldBackEnvelopes<T> {
    private readonly entries = new Map<string, HeldDecrypt & { value: T }>();

    private readonly ttlMs: number;
    private readonly maxEntries: number;

    constructor(ttlMs: number = 5 * 60_000, maxEntries: number = 100) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    hold(envelopeId: string, ciphertext_b64: string, value: T, now: number): void {
        this.entries.delete(envelopeId);
        this.entries.set(envelopeId, { ciphertext_b64, at: now, value });
        this.sweep(now);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    /** The held value for this envelope if it is fresh and the ciphertext is identical; removes it either way. */
    take(envelopeId: string, ciphertext_b64: string, now: number): T | null {
        const hit = this.entries.get(envelopeId);
        if (!hit) return null;
        this.entries.delete(envelopeId);
        if (now - hit.at > this.ttlMs) return null;
        if (hit.ciphertext_b64 !== ciphertext_b64) return null;
        return hit.value;
    }

    drop(envelopeId: string): void {
        this.entries.delete(envelopeId);
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }

    private sweep(now: number): void {
        for (const [id, e] of this.entries) {
            if (now - e.at > this.ttlMs) this.entries.delete(id);
        }
    }
}
