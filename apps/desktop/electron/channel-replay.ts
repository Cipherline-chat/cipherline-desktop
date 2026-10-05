import * as crypto from 'crypto';
import { secureStore } from './storage';

/**
 * G4: replay ledger for server-channel messages.
 *
 * A channel message is encrypted once under the channel's shared epoch key and
 * the server assigns its id. A malicious server can therefore take a genuine
 * row and re-insert it under a NEW id (and a new `created_at`): the signature
 * still verifies (it covers the ciphertext only) and the key still decrypts
 * it. Before this ledger, nothing on the client noticed. The id-based dedupe in
 * `foldChannelHistory` could not (the id is new), the live path's
 * `client_msg_id` dedupe caught it only while the original was still resident
 * in memory, and edit / reaction envelopes were re-applied with no dedupe at
 * all (a replayed "add reaction" re-adds one the user has since removed, and a
 * replayed "edit" rolls the text back).
 *
 * The ledger key is the AES-GCM nonce, scoped to the channel. The nonce is 96
 * random bits chosen by the sender for every message; a genuine sender never
 * repeats one under the same key (doing so would already break GCM), and the
 * server cannot change it without breaking the GCM tag. So "same channel, same
 * nonce, different server id" is a replay of an existing ciphertext, for
 * legacy (unbound) and bound messages alike. The value is a tag of the server
 * id the nonce was first accepted under, so re-reading the SAME row (every
 * history refresh re-decrypts the newest page) stays accepted.
 *
 * Persistence mirrors the DM replay set in e2ee-engine.ts, including its
 * load-state gate: the in-memory map starts empty, and writing it back before
 * the on-disk copy has been read would replace a real history with nothing.
 * Only a successful load (or a genuinely absent entry) enables writes; an
 * unreadable entry is left on disk untouched.
 *
 * Bounded FIFO. An entry evicted from the ledger is a message whose replay
 * would be admitted again, so the cap is sized well above a normal device's
 * 30-day channel volume (the server's channel retention) rather than tightly.
 */

const LEDGER_PERSIST_KEY = '__chan_replay__';
export const CHANNEL_REPLAY_LEDGER_MAX = 30_000;

type LoadState = 'pending' | 'loaded' | 'failed';

const ledger = new Map<string, string>();
let loadState: LoadState = 'pending';
let loadInProgress = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** True when the ledger holds entries not yet written — so a quit after a
 *  session that recorded nothing does not rewrite the whole vault. */
let dirty = false;

function b64(buf: Buffer): string {
    return buf.toString('base64').replace(/=+$/, '');
}

/** 128-bit, domain-separated. Channel id and nonce are length-prefixed by the
 *  NUL separator (neither can contain one: a UUID and base64). */
function ledgerKey(channelId: string, nonceB64: string): string {
    return b64(crypto.createHash('sha256')
        .update(`cl-chan-replay-v1\0${channelId}\0${nonceB64}`, 'utf8')
        .digest()
        .subarray(0, 16));
}

/** 96-bit tag of the server message id — enough to tell two ids apart, and it
 *  keeps the persisted ledger compact (it is re-serialised on every write). */
function idTag(messageId: string): string {
    return b64(crypto.createHash('sha256').update(`cl-chan-msgid-v1\0${messageId}`, 'utf8').digest().subarray(0, 12));
}

function markFailed(reason: string): void {
    loadState = 'failed';
    console.error(
        `[E2EE:CHANNEL_REPLAY] Persisted channel replay ledger unreadable — ${reason}. ` +
        'Cross-restart channel replay protection is degraded to this session only; the on-disk ' +
        'ledger is being LEFT INTACT rather than overwritten.',
    );
}

function ensureLoaded(): void {
    if (loadState !== 'pending' || loadInProgress) return;
    loadInProgress = true;
    try {
        let raw: string | null;
        try {
            raw = secureStore.get(LEDGER_PERSIST_KEY);
            if (raw === null && secureStore.keys().includes(LEDGER_PERSIST_KEY)) {
                markFailed('the persisted entry exists but could not be decrypted');
                return;
            }
        } catch (err) {
            // Store not initialised yet — transient, retry on the next message.
            console.error('[E2EE:CHANNEL_REPLAY] Could not read the persisted ledger (store not ready?):', err);
            return;
        }
        if (raw === null) { loadState = 'loaded'; return; }

        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { markFailed('not valid JSON'); return; }
        if (!Array.isArray(parsed) || parsed.some(e =>
            !Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string')) {
            markFailed('not an array of [key, id] string pairs');
            return;
        }
        // Merge only after full validation; keep the newest (FIFO eviction).
        // Entries recorded this session before the load landed are newer than
        // anything on disk, so they are re-appended after the disk copy.
        const sessionEntries = [...ledger.entries()];
        ledger.clear();
        for (const [k, v] of (parsed as [string, string][]).slice(-CHANNEL_REPLAY_LEDGER_MAX)) ledger.set(k, v);
        for (const [k, v] of sessionEntries) { ledger.delete(k); ledger.set(k, v); }
        trim();
        loadState = 'loaded';
    } finally {
        loadInProgress = false;
    }
}

function trim(): void {
    while (ledger.size > CHANNEL_REPLAY_LEDGER_MAX) {
        const oldest = ledger.keys().next().value;
        if (oldest === undefined) break;
        ledger.delete(oldest);
    }
}

function schedulePersist(): void {
    if (loadState !== 'loaded') return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
            // Written behind (see SecureStore.setDeferred): the ledger is up to
            // CHANNEL_REPLAY_LEDGER_MAX entries and rides a whole-vault rewrite.
            secureStore.setDeferred(LEDGER_PERSIST_KEY, JSON.stringify([...ledger.entries()]));
            dirty = false;
        } catch (err) {
            console.error('[E2EE:CHANNEL_REPLAY] Failed to persist the ledger:', err);
        }
    }, 500);
}

export type ChannelReplayVerdict = 'new' | 'same' | 'replay';

/**
 * Classify a (channel, nonce) pair against the ledger WITHOUT recording it.
 * 'same' = this exact server row was accepted before; 'replay' = this
 * ciphertext was already accepted under a DIFFERENT server id.
 */
export function classifyChannelNonce(channelId: string, nonceB64: string, messageId: string): ChannelReplayVerdict {
    ensureLoaded();
    const seen = ledger.get(ledgerKey(channelId, nonceB64));
    if (seen === undefined) return 'new';
    return seen === idTag(messageId) ? 'same' : 'replay';
}

/** Record an accepted message. Call ONLY after every check has passed, so a
 *  row that failed for another reason is never misfiled as the original. */
export function recordChannelNonce(channelId: string, nonceB64: string, messageId: string): void {
    ensureLoaded();
    const k = ledgerKey(channelId, nonceB64);
    if (ledger.has(k)) return;
    ledger.set(k, idTag(messageId));
    trim();
    dirty = true;
    schedulePersist();
}

/** Flush immediately (before-quit). A no-op unless the on-disk ledger loaded. */
export function flushChannelReplayLedger(): void {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (loadState !== 'loaded' || !dirty) return;
    try {
        secureStore.set(LEDGER_PERSIST_KEY, JSON.stringify([...ledger.entries()]));
        dirty = false;
    } catch (err) {
        console.error('[E2EE:CHANNEL_REPLAY] Failed to flush the ledger on shutdown:', err);
    }
}
