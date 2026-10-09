/**
 * "Waiting for this channel's keys" — the whole-pane state a server channel
 * shows instead of a page of "Couldn't decrypt — waiting on this channel's
 * key" pills, when this device can read NONE of the newest page yet.
 *
 * Two pure halves and one tiny store:
 *
 *  1. {@link needsKeyWaitState} — the decision. Shown only when the newest
 *     page (HISTORY_PAGE_SIZE rows) has messages, not one of them is readable,
 *     and the unreadable ones are mostly `key_missing` placeholders — the one
 *     failure a key request can fix (utils/channelDecryptFailure.ts). It is
 *     NOT shown for an empty channel, when any row decrypted (some keys are
 *     held: the per-message placeholders are honest there), when a row failed
 *     with a key we DO hold (`key_mismatch`), or for rows withheld by the
 *     Read Message History permission (`history_restricted` has its own
 *     honest label and no key is coming).
 *
 *  2. {@link deriveKeyWaitStage} — what the copy may say, from REAL signals
 *     only. Nothing here is a timer pretending to be progress:
 *       asking    → no key request for this channel has been acknowledged yet
 *       asked     → the server accepted a key request (POST …/key-request ok)
 *       received  → a key envelope for this channel was installed on this
 *                   device, and no decrypt started after it has finished yet
 *       building  → the history page is being decrypted with that key
 *       stalled   → nothing arrived for a while: no member who can share the
 *                   key has answered. Says so, calmly; it still finishes on
 *                   its own (the request is persistent server-side).
 *     A key that turns out not to cover the page (a decrypt that STARTED after
 *     it finished and the state is still up) drops the stage back to
 *     asked/stalled — it never claims progress that did not happen.
 *
 *  3. The signal store — Dashboard notes the three events it already performs
 *     (request acknowledged, key installed, page decrypt begin/end) per
 *     channel; the pane subscribes with useSyncExternalStore, so noting a
 *     signal never re-renders the 14k-line Dashboard.
 */
import { placeholderReason } from './channelDecryptFailure';
import { HISTORY_PAGE_SIZE } from './channelHistoryCoverage';

// ── 1. The decision ────────────────────────────────────────────────────────

export interface KeyWaitPageSummary {
    /** Rows that decrypted (or are this device's own sends). */
    readable: number;
    /** `key_missing` placeholders — a key request can fix these. */
    keyMissing: number;
    /** Held a key for the epoch, but not the one used (two keys minted). */
    keyMismatch: number;
    /** Withheld by permission / unverifiable sender: no key will fix them. */
    otherUndecryptable: number;
}

type RowLike = { id?: string; content?: unknown; sender_device_id?: string | null };

/**
 * Local, never-encrypted rows (the client-synthesised "X joined the server."
 * line, a malformed-content marker) say nothing about which keys are held, so
 * they count for neither side.
 */
function isNeutralRow(m: RowLike): boolean {
    const c = m.content as { type?: unknown } | null | undefined;
    return !!c && typeof c === 'object' && c.type === 'system';
}

export function summarizeNewestPage(rows: readonly RowLike[], pageSize = HISTORY_PAGE_SIZE): KeyWaitPageSummary {
    const page = rows.length > pageSize ? rows.slice(rows.length - pageSize) : rows;
    const s: KeyWaitPageSummary = { readable: 0, keyMissing: 0, keyMismatch: 0, otherUndecryptable: 0 };
    for (const m of page) {
        const reason = placeholderReason(m);
        if (reason === 'key_missing') s.keyMissing++;
        else if (reason === 'key_mismatch') s.keyMismatch++;
        else if (reason !== null) s.otherUndecryptable++;
        else if (!isNeutralRow(m)) s.readable++;
    }
    return s;
}

/** True when the open channel's newest page would render as (almost) nothing
 *  but "waiting on this channel's key" pills. */
export function needsKeyWaitState(rows: readonly RowLike[], pageSize = HISTORY_PAGE_SIZE): boolean {
    const s = summarizeNewestPage(rows, pageSize);
    return s.readable === 0
        && s.keyMismatch === 0
        && s.keyMissing > 0
        // "Mostly": missing keys must outnumber the rows no key can fix, so a
        // page that is chiefly history-restricted keeps its honest labels.
        && s.keyMissing > s.otherUndecryptable;
}

// ── 2. The stage ───────────────────────────────────────────────────────────

export type KeyWaitStage = 'asking' | 'asked' | 'stalled' | 'received' | 'building';

/** No answer for this long after the request (or after the state appeared,
 *  if no request was filed this session) → say so. */
export const KEY_WAIT_STALL_MS = 18_000;
/** …but never before the state has been on screen this long: opening a
 *  channel pulls envelopes that may already be waiting. */
export const KEY_WAIT_MIN_BEFORE_STALL_MS = 6_000;

/** Per-channel signals. `*Seq` are values of one session-wide monotonic
 *  counter, so "did X happen after Y" never depends on clock resolution. */
export interface KeyWaitSignals {
    /** Wall time of the first acknowledged key request this session. */
    firstRequestAckAt: number | null;
    requestAckSeq: number;
    keyReceivedSeq: number;
    /** Wall time of the latest key install (see KEY_RECEIVED_GRACE_MS). */
    keyReceivedAt: number | null;
    /** Start seqs of page decrypts in flight. */
    activeDecrypts: readonly number[];
    /** Highest start seq among decrypts that have FINISHED. */
    lastDoneDecryptSeq: number;
}

export const EMPTY_SIGNALS: KeyWaitSignals = Object.freeze({
    firstRequestAckAt: null,
    requestAckSeq: 0,
    keyReceivedSeq: 0,
    keyReceivedAt: null,
    activeDecrypts: Object.freeze([]) as readonly number[],
    lastDoneDecryptSeq: 0,
});

/** A key that no decrypt has picked up for this long is not presented as
 *  progress any more (every re-read path normally starts within a second). */
export const KEY_RECEIVED_GRACE_MS = 10_000;

export const STAGE_RANK: Record<KeyWaitStage, number> = { asking: 0, asked: 1, stalled: 1, received: 2, building: 3 };

export function isDecrypting(s: KeyWaitSignals): boolean {
    return s.activeDecrypts.length > 0;
}

export function deriveKeyWaitStage(s: KeyWaitSignals, shownAt: number, now: number): KeyWaitStage {
    const key = s.keyReceivedSeq;
    if (key > 0) {
        // A decrypt that started after the key and is still running.
        if (s.activeDecrypts.some(seq => seq > key)) return 'building';
        // The key has not been tried on the page yet.
        if (key > s.lastDoneDecryptSeq
            && (s.keyReceivedAt === null || now - s.keyReceivedAt < KEY_RECEIVED_GRACE_MS)) return 'received';
        // Tried, and the page is still unreadable: that key was for another
        // epoch. Fall through to the honest waiting copy.
    }
    if (now >= stallAt(s, shownAt)) return 'stalled';
    return s.requestAckSeq > 0 ? 'asked' : 'asking';
}

/** The next instant the stage can change by time alone (null = none). */
export function nextStageDeadline(s: KeyWaitSignals, shownAt: number, now: number): number | null {
    const candidates: number[] = [];
    const stall = stallAt(s, shownAt);
    if (stall > now) candidates.push(stall);
    if (s.keyReceivedAt !== null) {
        const grace = s.keyReceivedAt + KEY_RECEIVED_GRACE_MS;
        if (grace > now) candidates.push(grace);
    }
    return candidates.length ? Math.min(...candidates) : null;
}

/** When the waiting copy turns into "no one has answered". */
export function stallAt(s: KeyWaitSignals, shownAt: number): number {
    const since = s.firstRequestAckAt !== null ? Math.min(s.firstRequestAckAt, shownAt) : shownAt;
    return Math.max(shownAt + KEY_WAIT_MIN_BEFORE_STALL_MS, since + KEY_WAIT_STALL_MS);
}

export interface KeyWaitCopy { title: string; detail: string }

export const KEY_WAIT_COPY: Record<KeyWaitStage, KeyWaitCopy> = {
    asking: {
        title: 'Asking online members for encryption keys…',
        detail: 'This channel is end-to-end encrypted. Its keys come from other members’ devices — never from the server.',
    },
    asked: {
        title: 'Asking online members for encryption keys…',
        detail: 'Request sent. The first member’s device to see it will pass the keys along.',
    },
    stalled: {
        title: 'No one who can share keys has answered yet',
        detail: 'They may all be offline right now. This finishes on its own as soon as one of them is — you can leave and come back.',
    },
    received: {
        title: 'Keys received — decrypting messages…',
        detail: 'A member’s device sent this channel’s keys. Unlocking the history on this device.',
    },
    building: {
        title: 'Building the chat…',
        detail: 'Decrypting the latest messages on this device.',
    },
};

// ── 3. The signal store ────────────────────────────────────────────────────

let seq = 0;
const byChannel = new Map<string, KeyWaitSignals>();
const listeners = new Set<() => void>();

function update(channelId: string, f: (s: KeyWaitSignals) => KeyWaitSignals) {
    const next = f(byChannel.get(channelId) ?? EMPTY_SIGNALS);
    byChannel.set(channelId, next);
    for (const l of [...listeners]) l();
}

export function getKeyWaitSignals(channelId: string | null | undefined): KeyWaitSignals {
    return (channelId && byChannel.get(channelId)) || EMPTY_SIGNALS;
}

export function subscribeKeyWaitSignals(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The server accepted a key request for this channel. */
export function noteKeyRequestAcked(channelId: string, now = Date.now()) {
    update(channelId, s => ({ ...s, requestAckSeq: ++seq, firstRequestAckAt: s.firstRequestAckAt ?? now }));
}

/** A key envelope for this channel was installed on this device. */
export function noteChannelKeyReceived(channelId: string, now = Date.now()) {
    update(channelId, s => ({ ...s, keyReceivedSeq: ++seq, keyReceivedAt: now }));
}

/** A history page for this channel is being decrypted; call the returned
 *  function once its rows are folded into the thread (exactly once). */
export function beginChannelPageDecrypt(channelId: string): () => void {
    const mine = ++seq;
    update(channelId, s => ({ ...s, activeDecrypts: [...s.activeDecrypts, mine] }));
    let done = false;
    return () => {
        if (done) return;
        done = true;
        update(channelId, s => ({
            ...s,
            activeDecrypts: s.activeDecrypts.filter(v => v !== mine),
            lastDoneDecryptSeq: Math.max(s.lastDoneDecryptSeq, mine),
        }));
    };
}

/** Sign-out / tests. */
export function resetKeyWaitSignals() {
    byChannel.clear();
    for (const l of [...listeners]) l();
}
