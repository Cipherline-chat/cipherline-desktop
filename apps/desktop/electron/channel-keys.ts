/**
 * Channel key store for Sender Keys E2EE.
 *
 * Each text channel has a shared symmetric AES-256-GCM key (one per epoch).
 * Keys are received via per-recipient envelopes (the existing E2EE pipeline)
 * on initial channel join and on every rotation event. They are stored here,
 * wrapped by SecureStore (DPAPI / Keychain / libsecret), and expired after
 * 30 days to bound local storage growth.
 *
 * The server never sees key bytes — only rotation metadata (epoch, reason).
 */

import * as crypto from 'crypto';
import { secureStore } from './storage';

// Drop keys older than 30 days (keeps history decryptable for that window).
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// RC-10: age-based pruning alone can drop an epoch that's numerically recent
// but still older than PRUNE_AFTER_MS in wall-clock terms (a quiet channel
// that hasn't rotated in a while). Retaining the newest N regardless of age
// is a cheap backstop against exactly that — bounded local storage growth,
// but a much wider safety margin than "keep only the single latest epoch".
const RETAIN_NEWEST_COUNT = 50;

interface ChannelKeyEntry {
    /** 32-byte key as lowercase hex (avoids Base64 padding ambiguity in JSON). */
    keyHex: string;
    /** ISO8601 — when this key epoch should next rotate. */
    rotatesAt: string;
}

// Hot cache in main-process memory: channelId → epoch → entry
const cache = new Map<string, Map<number, ChannelKeyEntry>>();

// ---------------------------------------------------------------------------
// SecureStore keys
// ---------------------------------------------------------------------------

function storeKey(channelId: string): string {
    return `channel_keys:${channelId}`;
}

function protectedEpochsKey(channelId: string): string {
    return `protected_epochs:${channelId}`;
}

function loadFromStore(channelId: string): Map<number, ChannelKeyEntry> {
    const m = new Map<number, ChannelKeyEntry>();
    const raw = secureStore.get(storeKey(channelId));
    if (!raw) return m;
    try {
        const parsed = JSON.parse(raw) as Record<string, ChannelKeyEntry>;
        for (const [epochStr, entry] of Object.entries(parsed)) {
            const epoch = parseInt(epochStr, 10);
            if (!isNaN(epoch) && entry.keyHex && entry.rotatesAt) {
                m.set(epoch, entry);
            }
        }
    } catch (err) {
        console.error('[ChannelKeys] Failed to parse stored keys for channel', channelId, err);
    }
    return m;
}

function serializeEpochs(m: Map<number, ChannelKeyEntry>): string {
    const obj: Record<string, ChannelKeyEntry> = {};
    for (const [epoch, entry] of m.entries()) {
        obj[epoch.toString()] = entry;
    }
    return JSON.stringify(obj);
}

function saveToStore(channelId: string, m: Map<number, ChannelKeyEntry>): void {
    secureStore.set(storeKey(channelId), serializeEpochs(m));
}

function getOrLoad(channelId: string): Map<number, ChannelKeyEntry> {
    if (!cache.has(channelId)) {
        cache.set(channelId, loadFromStore(channelId));
    }
    return cache.get(channelId)!;
}

/** SHA-256 of the raw key bytes, base64 — opaque metadata safe to send the server. */
function fingerprintOf(keyHex: string): string {
    return crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('base64');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a channel key received from a `channel_key` envelope.
 * @param keyB64 Raw 32-byte AES key, base64-encoded.
 * @param opts.replaceIfFingerprintB64 If a conflicting key already exists for
 *   this epoch, replace it anyway when the INCOMING key's fingerprint matches
 *   this value — used only for split-brain repair, where the caller fetched
 *   the server-arbitrated winning fingerprint and confirmed this envelope is
 *   the winner's key before calling. Never bypasses the conflict guard for
 *   an unverified key.
 * @returns 'stored' (new epoch or verified replacement), 'duplicate' (same
 *   key already held, no-op), or 'conflict' (refused — caller should not
 *   treat this key as installed).
 */
export function setChannelKey(
    channelId: string,
    epoch: number,
    keyB64: string,
    rotatesAt: Date,
    opts?: { replaceIfFingerprintB64?: string },
): 'stored' | 'duplicate' | 'conflict' {
    const m = getOrLoad(channelId);
    const incomingHex = Buffer.from(keyB64, 'base64').toString('hex');
    const existing = m.get(epoch);
    if (existing) {
        if (existing.keyHex !== incomingHex) {
            // Two different keys for the same epoch — possible concurrent rotation.
            // Refuse to overwrite by default (first writer wins, P2-ELEC-9) UNLESS
            // the caller proves this incoming key is the server-arbitrated winner.
            if (opts?.replaceIfFingerprintB64 && opts.replaceIfFingerprintB64 === fingerprintOf(incomingHex)) {
                m.set(epoch, { keyHex: incomingHex, rotatesAt: rotatesAt.toISOString() });
                saveToStore(channelId, m);
                console.warn(`[ChannelKeys] Epoch ${epoch} conflict on channel ${channelId}: replacing with server-arbitrated winner`);
                return 'stored';
            }
            console.warn(`[ChannelKeys] Epoch ${epoch} conflict on channel ${channelId}: refusing overwrite`);
            return 'conflict';
        }
        return 'duplicate'; // same key already stored, no-op
    }
    m.set(epoch, { keyHex: incomingHex, rotatesAt: rotatesAt.toISOString() });
    saveToStore(channelId, m);
    return 'stored';
}

/** SHA-256 fingerprint (base64) of the key we hold for this epoch, or null. */
export function getChannelKeyFingerprint(channelId: string, epoch: number): string | null {
    const entry = getOrLoad(channelId).get(epoch);
    return entry ? fingerprintOf(entry.keyHex) : null;
}

/** epoch → fingerprint for every epoch this device holds for the channel. */
export function listChannelEpochFingerprints(channelId: string): Record<number, string> {
    const m = getOrLoad(channelId);
    const out: Record<number, string> = {};
    for (const [epoch, entry] of m.entries()) out[epoch] = fingerprintOf(entry.keyHex);
    return out;
}

/**
 * Discard a locally held epoch key — used by split-brain repair when this
 * device's key for an epoch doesn't match the server-arbitrated fingerprint
 * (it lost the recordEpoch race) and must re-request the winner's key.
 */
export function discardChannelKey(channelId: string, epoch: number): void {
    const m = getOrLoad(channelId);
    if (!m.delete(epoch)) return;
    saveToStore(channelId, m);
    console.log(`[ChannelKeys] Discarded epoch ${epoch} for channel ${channelId} (lost arbitration)`);
}

/**
 * Retrieve a channel key Buffer for decryption.
 * Returns null if the key is not in local storage (needs a rotation re-send).
 */
export function getChannelKey(channelId: string, epoch: number): Buffer | null {
    const entry = getOrLoad(channelId).get(epoch);
    if (!entry) return null;
    return Buffer.from(entry.keyHex, 'hex');
}

/**
 * Highest epoch we have a key for in this channel. Null if none.
 */
export function getLatestEpoch(channelId: string): number | null {
    const m = getOrLoad(channelId);
    if (m.size === 0) return null;
    return Math.max(...m.keys());
}

/**
 * All epoch numbers we hold a key for in this channel, ascending. Used by
 * distribution flows that back-fill FULL history to a keyless member (a
 * new joiner / newly-permitted device), not just the latest epoch.
 */
export function listChannelEpochs(channelId: string): number[] {
    return [...getOrLoad(channelId).keys()].sort((a, b) => a - b);
}

/**
 * Generate a new epoch key for this channel (called by the rotation actor —
 * the admin/owner who initiates a key rotation, or the create-time minter).
 * Stores the new key locally and returns it for distribution to other
 * members via per-recipient envelopes.
 *
 * @param atEpoch Explicit target epoch, used only by fallback recovery
 *   rotation (mint at `serverLatest + 1` when no key-holder ever came
 *   online). Defaults to one past whatever this device currently holds.
 * @returns { epoch, keyB64 } — the new key ready to be wrapped and sent.
 */
export function rotateChannelKey(channelId: string, atEpoch?: number): { epoch: number; keyB64: string; rotatesAt: Date } {
    const currentEpoch = getLatestEpoch(channelId) ?? 0;
    const newEpoch = atEpoch ?? (currentEpoch + 1);
    const key = crypto.randomBytes(32);
    const keyB64 = key.toString('base64');
    // Default rotation schedule: 7 days from now
    const rotatesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = setChannelKey(channelId, newEpoch, keyB64, rotatesAt);
    if (result === 'conflict') {
        // A concurrent caller (only reachable via the `atEpoch` fallback-
        // rotation path — normal epoch-1 minting always targets a fresh
        // epoch) already stored a DIFFERENT key for this epoch, and it won
        // — setChannelKey refused to overwrite it. Returning the freshly
        // generated (unstored) key here would silently break the contract
        // "the returned key equals what's actually stored": every caller
        // (fingerprinting, distribution) would then operate on a key nobody
        // holds. Read back what's really stored instead.
        const stored = getOrLoad(channelId).get(newEpoch)!;
        console.warn(`[ChannelKeys] rotateChannelKey lost a conflict for channel ${channelId} epoch ${newEpoch} — returning the already-stored key instead`);
        return { epoch: newEpoch, keyB64: Buffer.from(stored.keyHex, 'hex').toString('base64'), rotatesAt: new Date(stored.rotatesAt) };
    }
    console.log(`[ChannelKeys] Rotated channel ${channelId}: epoch ${currentEpoch} → ${newEpoch}`);
    return { epoch: newEpoch, keyB64, rotatesAt };
}

/**
 * RC-10: epochs a pin in this channel references, refreshed by the renderer
 * from GET /servers/:sid/pinned-epochs (server open + hourly — see
 * Dashboard.tsx's refreshProtectedEpochs) and consulted here so pruneOldKeys
 * never deletes the only local copy of a key a pinned message needs.
 * Wholesale-replaces the set on every call — the caller always sends the
 * server's current authoritative list, not a delta.
 */
export function setProtectedEpochs(channelId: string, epochs: number[]): void {
    const clean = [...new Set(epochs.filter(e => Number.isInteger(e)))].sort((a, b) => a - b);
    secureStore.set(protectedEpochsKey(channelId), JSON.stringify(clean));
}

function loadProtectedEpochs(channelId: string): Set<number> {
    const raw = secureStore.get(protectedEpochsKey(channelId));
    if (!raw) return new Set();
    try {
        const arr = JSON.parse(raw) as unknown;
        return new Set(Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n)) : []);
    } catch {
        return new Set();
    }
}

/**
 * Drop key epochs older than PRUNE_AFTER_MS (30 days). Enumerates all
 * channel_keys:* entries from SecureStore directly so it works at startup
 * before the cache is warm (P2-ELEC-9: iterating the empty cache was a no-op).
 * The highest epoch per channel is NEVER pruned regardless of age, so current
 * messages always decrypt (P2-ELEC-9: age heuristic could delete the live epoch).
 * RC-10: neither are the RETAIN_NEWEST_COUNT most recent epochs, nor any
 * epoch a pin in this channel references (setProtectedEpochs) — a pruned
 * epoch a pin needs is permanently unreadable for anyone who joins after,
 * since there is then no holder left to redistribute it from.
 */
export function pruneOldKeys(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const PREFIX = 'channel_keys:';

    // Collected here and written in ONE `setMany` at the end rather than a
    // `set()` per channel. `SecureStore.set()` calls `save()`, and `save()`
    // re-serialises the ENTIRE vault and does a writeFileSync + renameSync —
    // so the old shape was N full-vault rewrites, serially, on the Electron
    // main process's UI thread, before `createWindow()` has even run. That is
    // the thread that owns the window HWND, so blocking it is what Windows
    // reports as "(Not Responding)". Batching also makes the prune atomic: a
    // crash mid-loop previously left some channels pruned and some not.
    const pending: Record<string, string> = {};

    for (const storeKeyStr of secureStore.keys()) {
        if (!storeKeyStr.startsWith(PREFIX)) continue;
        const channelId = storeKeyStr.slice(PREFIX.length);

        const m = getOrLoad(channelId);
        if (m.size === 0) continue;

        const highestEpoch = Math.max(...m.keys());
        const protectedEpochs = loadProtectedEpochs(channelId);
        const retainedByRecency = new Set(
            [...m.keys()].sort((a, b) => b - a).slice(0, RETAIN_NEWEST_COUNT),
        );
        let changed = false;

        for (const [epoch, entry] of m.entries()) {
            if (epoch === highestEpoch) continue; // always keep the latest epoch
            if (retainedByRecency.has(epoch)) continue;
            if (protectedEpochs.has(epoch)) continue; // pinned — see setProtectedEpochs
            const createdApprox = new Date(entry.rotatesAt).getTime() - 7 * 24 * 60 * 60 * 1000;
            if (createdApprox < cutoff) {
                m.delete(epoch);
                changed = true;
                console.log(`[ChannelKeys] Pruned epoch ${epoch} for channel ${channelId}`);
            }
        }
        if (changed) pending[storeKey(channelId)] = serializeEpochs(m);
    }

    if (Object.keys(pending).length > 0) secureStore.setMany(pending);
}
