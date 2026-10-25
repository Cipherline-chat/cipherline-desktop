/**
 * Reassembles one sender's custom sound from its (already decrypted) chunks,
 * with hard bounds so a peer cannot make us hold memory:
 *   - at most MAX_CHUNKS chunks and MAX_ENCODED_BYTES in total per sound,
 *   - ONE sound in flight per sender (a new id replaces the old),
 *   - at most MAX_PENDING senders in flight (the oldest is dropped),
 *   - an incomplete sound is dropped TIMEOUT_MS after its first chunk.
 * Out-of-order chunks are fine; a duplicate is ignored; a chunk that
 * contradicts what we have (another total) drops the whole attempt.
 * Pure and clock-injected.
 */

import { MAX_ENCODED_BYTES } from './constants';
import { MAX_CHUNKS, type PacketHeader } from './wire';

export const ASSEMBLY_TIMEOUT_MS = 10_000;
export const MAX_PENDING = 16;

interface Pending { id: string; total: number; chunks: Array<Uint8Array | undefined>; got: number; bytes: number; startedAt: number }

export type PushResult =
    | { status: 'complete'; id: string; bytes: Uint8Array }
    | { status: 'pending' }
    | { status: 'duplicate' }
    | { status: 'rejected'; reason: 'bounds' | 'mismatch' };

export class SoundAssembler {
    private pending = new Map<string, Pending>();
    private readonly now: () => number;
    private readonly timeoutMs: number;

    constructor(opts: { now?: () => number; timeoutMs?: number } = {}) {
        this.now = opts.now ?? (() => Date.now());
        this.timeoutMs = opts.timeoutMs ?? ASSEMBLY_TIMEOUT_MS;
    }

    /** Drop attempts older than the timeout. */
    sweep(): void {
        const t = this.now();
        for (const [k, p] of this.pending) if (t - p.startedAt >= this.timeoutMs) this.pending.delete(k);
    }

    push(sender: string, h: PacketHeader, chunk: Uint8Array): PushResult {
        this.sweep();
        if (h.total < 1 || h.total > MAX_CHUNKS || h.index < 0 || h.index >= h.total || chunk.length === 0) {
            return { status: 'rejected', reason: 'bounds' };
        }
        let p = this.pending.get(sender);
        if (p && p.id !== h.id) { this.pending.delete(sender); p = undefined; }
        if (p && p.total !== h.total) { this.pending.delete(sender); return { status: 'rejected', reason: 'mismatch' }; }
        if (!p) {
            if (this.pending.size >= MAX_PENDING) {
                let oldest: string | null = null;
                let at = Infinity;
                for (const [k, v] of this.pending) if (v.startedAt < at) { at = v.startedAt; oldest = k; }
                if (oldest !== null) this.pending.delete(oldest);
            }
            p = { id: h.id, total: h.total, chunks: new Array(h.total), got: 0, bytes: 0, startedAt: this.now() };
            this.pending.set(sender, p);
        }
        if (p.chunks[h.index]) return { status: 'duplicate' };
        if (p.bytes + chunk.length > MAX_ENCODED_BYTES) { this.pending.delete(sender); return { status: 'rejected', reason: 'bounds' }; }
        p.chunks[h.index] = chunk;
        p.got++;
        p.bytes += chunk.length;
        if (p.got < p.total) return { status: 'pending' };
        this.pending.delete(sender);
        const out = new Uint8Array(p.bytes);
        let o = 0;
        for (const c of p.chunks) { out.set(c!, o); o += c!.length; }
        return { status: 'complete', id: p.id, bytes: out };
    }

    /** A sender left: forget their attempt. */
    forget(sender: string): void { this.pending.delete(sender); }
    pendingCount(): number { return this.pending.size; }
    clear(): void { this.pending.clear(); }
}
