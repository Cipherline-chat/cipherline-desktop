/**
 * "Getting this channel's keys" — the whole-pane state a server channel shows
 * instead of a feed of "Couldn't decrypt — waiting on this channel's key"
 * pills, whenever what would be ON SCREEN needs a key this device does not
 * hold yet — on every open, not only the first.
 *
 * Owner report 2026-10-20: people joining a server never saw it — they got
 * the feed full of pills. Two reasons, both fixed here and in
 * hooks/useChannelKeyWait.ts:
 *  - the rule required the newest page to have ZERO readable rows, and a
 *    joiner's page often spans several epochs (2–6 on the busiest prod
 *    channels) whose keys arrive one envelope at a time — often the newest
 *    first. One readable row cancelled the state;
 *  - the hook latched "never again for this pane" on the FIRST non-empty
 *    render, and a joiner's own "X joined the server." line lands (live,
 *    over WS) before the history page does.
 *
 * Pieces:
 *
 *  1. {@link needsKeyWaitState} — the decision (its doc has the rules). Only
 *     `key_missing` rows count as waiting — the one failure a key request can
 *     fix (utils/channelDecryptFailure.ts). A page that is mostly withheld by
 *     Read Message History (`history_restricted`), or mostly `key_mismatch` /
 *     `unverified`, keeps its honest per-row labels.
 *
 *  2. {@link deriveKeyWaitStage} — what the copy may say, from REAL signals
 *     only. Nothing here is a timer pretending to be progress:
 *       asking    → no key request for this channel has been acknowledged yet
 *       asked     → the server accepted a key request (POST …/key-request ok)
 *       received  → a key envelope for this channel was installed on this
 *                   device, and no decrypt started after it has finished yet
 *       building  → the history page is being decrypted with that key
 *       stalled   → nothing arrived for a while: no member who can share the
 *                   key has answered. Says so, calmly.
 *     A key that turns out not to cover the page (a decrypt that STARTED after
 *     it finished and the state is still up) drops the stage back to
 *     asked/stalled — it never claims progress that did not happen.
 *
 *  3. Not trapping anyone — {@link keyWaitGiveUpAt}: a wait nobody answers
 *     hands over to the feed with ONE banner ({@link KEY_WAIT_BANNER_COPY})
 *     and the placeholders collapsed ({@link keyMissingRuns}). The give-up is
 *     remembered per channel ({@link isGiveUpRemembered}) until a key arrives,
 *     so re-opening the channel does not replay the same unanswered wait.
 *
 *  4. The signal store — Dashboard notes events it already performs (channel
 *     open, request acknowledged, key installed, page decrypt begin/end) per
 *     channel; the pane subscribes with useSyncExternalStore, so noting a
 *     signal never re-renders the 14k-line Dashboard.
 */
import { placeholderReason } from './channelDecryptFailure';
import { HISTORY_PAGE_SIZE } from './channelHistoryCoverage';
import { noteBetaKeyReceived } from './betaDiagnostics/detectors';

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
 * Local, never-encrypted rows (the "X joined the server." line, a
 * malformed-content marker) say nothing about which keys are held, so they
 * count for neither side.
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

/** How many of the newest encrypted rows count as "what is on screen" when a
 *  channel opens (the feed is bottom-anchored: about one screenful on a
 *  desktop window, a little more than one on a laptop). */
export const KEY_WAIT_VISIBLE_ROWS = 25;

export interface KeyWaitWindowSummary {
    /** Encrypted (non-neutral) rows in the window. */
    total: number;
    keyMissing: number;
    /** The newest encrypted row is waiting on a key: this device does not
     *  hold the epoch the channel's latest message was sent under. */
    newestWaiting: boolean;
}

/** The newest `size` encrypted rows of `rows` (oldest-first thread order). */
export function summarizeVisibleWindow(rows: readonly RowLike[], size = KEY_WAIT_VISIBLE_ROWS): KeyWaitWindowSummary {
    const out: KeyWaitWindowSummary = { total: 0, keyMissing: 0, newestWaiting: false };
    for (let i = rows.length - 1; i >= 0 && out.total < size; i--) {
        const m = rows[i];
        const reason = placeholderReason(m);
        if (reason === null && isNeutralRow(m)) continue;
        if (out.total === 0) out.newestWaiting = reason === 'key_missing';
        out.total++;
        if (reason === 'key_missing') out.keyMissing++;
    }
    return out;
}

/** True when the open channel should show the key-loading view instead of
 *  its feed. Rules (2026-10-20), over the newest page (HISTORY_PAGE_SIZE rows):
 *
 *   - something is waiting on a key at all (`key_missing` > 0), and
 *   - waiting rows outnumber the rows no key will fix (`key_mismatch`,
 *     `unverified`, `history_restricted`) — a page chiefly withheld by
 *     permission keeps its honest labels — and
 *   - one of:
 *       a. the NEWEST message is waiting: the newest epoch's key is missing,
 *          so the first thing the user would read is a pill;
 *       b. the visible window (newest KEY_WAIT_VISIBLE_ROWS encrypted rows)
 *          is MORE than half waiting;
 *       c. `newestKeyPending` (utils/keyReask.ts: asked while holding no key
 *          at all, newest epoch not installed yet) and the page has more
 *          waiting rows than readable ones.
 *
 *  NOT shown: an empty channel (the composer's own gate says what is
 *  missing); a page whose missing keys are all OLDER than what is on screen
 *  (a history-only gap: the feed shows its readable rows and one compact
 *  "N messages waiting" row); local system lines alone.
 *
 *  Whether a key can still arrive is the hook's call (it gives up to the
 *  feed + banner), not this function's. */
export function needsKeyWaitState(
    rows: readonly RowLike[],
    pageSize = HISTORY_PAGE_SIZE,
    opts: { newestKeyPending?: boolean } = {},
): boolean {
    const page = rows.length > pageSize ? rows.slice(rows.length - pageSize) : rows;
    const s = summarizeNewestPage(page, pageSize);
    if (s.keyMissing === 0) return false;
    if (s.keyMissing <= s.keyMismatch + s.otherUndecryptable) return false;
    const v = summarizeVisibleWindow(page);
    if (v.newestWaiting) return true;
    if (v.keyMissing * 2 > v.total) return true;
    return !!opts.newestKeyPending && s.keyMissing > s.readable;
}

// ── 1b. The fallback banner ────────────────────────────────────────────────

/**
 * Whether the open channel's feed warrants the ONE "waiting for someone with
 * the keys" banner: the NEWEST encrypted message on screen is waiting on a
 * key (the channel's current key is not on this device), and waiting rows
 * outnumber the ones no key will fix. Stricter than needsKeyWaitState on
 * purpose (2026-10-20, owner: the banner "showed up for someone who had
 * access to the channel they were viewing ... kept appearing over and over"):
 * a channel whose newest message reads fine has its key — older locked rows
 * there (a history gap, or an epoch nobody holds any more) get the compact
 * "N messages waiting" row, never this banner.
 */
export function needsKeyWaitBanner(rows: readonly RowLike[], pageSize = HISTORY_PAGE_SIZE): boolean {
    const page = rows.length > pageSize ? rows.slice(rows.length - pageSize) : rows;
    const s = summarizeNewestPage(page, pageSize);
    if (s.keyMissing === 0) return false;
    if (s.keyMissing <= s.keyMismatch + s.otherUndecryptable) return false;
    return summarizeVisibleWindow(page).newestWaiting;
}

export interface KeyWaitBannerInput {
    /** needsKeyWaitBanner for the rows on screen right now. */
    wanted: boolean;
    /** The whole-pane layer is up (shown / pending): it says it instead. */
    layerUp: boolean;
    /** The layer handed over without the keys (or a remembered give-up). */
    gaveUp: boolean;
    /** When `wanted` last became true (null while it is false). */
    waitingSince: number | null;
    now: number;
    signals: KeyWaitSignals;
    /** The banner's current state. */
    latched: boolean;
}

/**
 * The banner's next state. A LATCH, so it cannot flap: once up it stays up
 * until the newest message is readable (or the layer takes over) — a page
 * re-decrypt, a key for some other epoch, or a duplicate copy of a key do
 * not take it down and put it back. It goes up only after the newest message
 * has waited KEY_WAIT_STALL_MS with no decrypt running and no new key in the
 * last KEY_RECEIVED_GRACE_MS (still within budget = no banner), or at once
 * after the layer gave up.
 */
export function nextKeyWaitBanner(i: KeyWaitBannerInput): boolean {
    if (!i.wanted || i.layerUp) return false;
    if (i.latched || i.gaveUp) return true;
    if (i.waitingSince === null || i.now < i.waitingSince + KEY_WAIT_STALL_MS) return false;
    if (isDecrypting(i.signals)) return false;
    if (i.signals.keyReceivedAt !== null && i.now - i.signals.keyReceivedAt < KEY_RECEIVED_GRACE_MS) return false;
    return true;
}

/** The next instant nextKeyWaitBanner can turn true by time alone (null = none). */
export function keyWaitBannerDueAt(i: KeyWaitBannerInput): number | null {
    if (!i.wanted || i.layerUp || i.latched || i.gaveUp || i.waitingSince === null) return null;
    const at = Math.max(
        i.waitingSince + KEY_WAIT_STALL_MS,
        i.signals.keyReceivedAt !== null ? i.signals.keyReceivedAt + KEY_RECEIVED_GRACE_MS : 0,
    );
    return at > i.now ? at : null;
}

/** Any row that says something about which keys are held (not only local
 *  system lines). Until one exists the pane has nothing to decide on. */
export function hasEncryptedRows(rows: readonly RowLike[]): boolean {
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = rows[i];
        if (placeholderReason(m) !== null || !isNeutralRow(m)) return true;
    }
    return false;
}

/**
 * Consecutive `key_missing` placeholders, collapsed: a run of two or more
 * renders as ONE compact row ("12 messages waiting for this channel's key")
 * instead of twelve identical pills. Returns, per row id, the run length on
 * the run's FIRST row and 0 on every other row of the run (render nothing).
 * Rows not in a run of ≥ 2 are absent. `breakBefore(id)` ends a run before
 * that row (a history-gap marker renders there; a run must not swallow it).
 */
export function keyMissingRuns(
    rows: ReadonlyArray<{ id: string; content?: unknown }>,
    breakBefore?: (id: string) => boolean,
): Map<string, number> {
    const out = new Map<string, number>();
    let i = 0;
    while (i < rows.length) {
        if (placeholderReason(rows[i]) !== 'key_missing') { i++; continue; }
        let j = i + 1;
        while (j < rows.length && placeholderReason(rows[j]) === 'key_missing' && !breakBefore?.(rows[j].id)) j++;
        if (j - i >= 2) {
            out.set(rows[i].id, j - i);
            for (let k = i + 1; k < j; k++) out.set(rows[k].id, 0);
        }
        i = j;
    }
    return out;
}

export function keyMissingRunLabel(count: number): string {
    return `${count} messages waiting for this channel’s key`;
}

// ── 2. The stage ───────────────────────────────────────────────────────────

export type KeyWaitStage = 'asking' | 'asked' | 'stalled' | 'received' | 'building';

/** No answer for this long after the request (or after the state appeared,
 *  if no request was filed this session) → say so. */
export const KEY_WAIT_STALL_MS = 18_000;
/** …but never before the state has been on screen this long: opening a
 *  channel pulls envelopes that may already be waiting. */
export const KEY_WAIT_MIN_BEFORE_STALL_MS = 6_000;
/** The "no one has answered" copy stays up this long, then the layer hands
 *  over to the feed + banner (keyWaitGiveUpAt). */
export const KEY_WAIT_STALLED_DWELL_MS = 4_000;
/** A give-up is remembered for the channel this long (unless a key arrives
 *  first): re-opening it meanwhile goes straight to the feed + banner. */
export const KEY_WAIT_GIVE_UP_MEMORY_MS = 10 * 60_000;

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
    /** Asked while holding no key; the newest epoch has not been installed
     *  yet (see needsKeyWaitState). */
    newestKeyPending?: boolean;
    /** Channel opens in flight (Dashboard.handleSelectChannel: key bootstrap
     *  + history re-read). While one runs, rows already on screen may be
     *  stale placeholders about to heal — see the hook's `pending` phase. */
    activeOpens?: readonly number[];
    /** When the layer last gave up on this channel, and the keyReceivedSeq
     *  at that moment (a key since then cancels the memory). */
    gaveUpAt?: number | null;
    gaveUpKeySeq?: number;
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

export function isOpening(s: KeyWaitSignals): boolean {
    return (s.activeOpens?.length ?? 0) > 0;
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

/** When a layer that is still waiting hands over to the feed + banner: the
 *  stalled copy has been readable for KEY_WAIT_STALLED_DWELL_MS, and no key
 *  has arrived for KEY_WAIT_STALL_MS (a key that lands keeps the wait alive —
 *  progress is not a reason to give up). The hook additionally never gives
 *  up while a page decrypt is running. */
export function keyWaitGiveUpAt(s: KeyWaitSignals, shownAt: number): number {
    const base = stallAt(s, shownAt) + KEY_WAIT_STALLED_DWELL_MS;
    const sinceKey = s.keyReceivedAt !== null ? s.keyReceivedAt + KEY_WAIT_STALL_MS : 0;
    return Math.max(base, sinceKey);
}

/** This channel's last wait went unanswered recently and no key has arrived
 *  since: open straight into the feed + banner. */
export function isGiveUpRemembered(s: KeyWaitSignals, now: number): boolean {
    return typeof s.gaveUpAt === 'number'
        && s.keyReceivedSeq === (s.gaveUpKeySeq ?? 0)
        && now - s.gaveUpAt < KEY_WAIT_GIVE_UP_MEMORY_MS;
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
        // Re-asks keep going behind this (utils/keyReask.ts) — the copy says so
        // rather than implying the request was sent once and forgotten.
        detail: 'They may all be offline right now. Your device keeps asking, and messages unlock on their own as soon as one of them answers.',
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

/** The single banner over the feed once a wait has gone unanswered. */
export const KEY_WAIT_BANNER_COPY = {
    title: 'Waiting for someone with the keys to come online',
    detail: 'Locked messages here unlock on their own as soon as a member who has this channel’s keys is online.',
    retry: 'Ask again',
    retried: 'Asked',
} as const;

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
    noteBetaKeyReceived(channelId); // beta diagnostics: this channel's key wait is over
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

/** The user opened this channel and Dashboard is pulling waiting keys and
 *  re-reading its newest page; call the returned function when that settles
 *  (exactly once, success or not). */
export function beginChannelOpen(channelId: string): () => void {
    const mine = ++seq;
    update(channelId, s => ({ ...s, activeOpens: [...(s.activeOpens ?? []), mine] }));
    let done = false;
    return () => {
        if (done) return;
        done = true;
        update(channelId, s => ({ ...s, activeOpens: (s.activeOpens ?? []).filter(v => v !== mine) }));
    };
}

/** The layer gave up waiting on this channel (see isGiveUpRemembered). */
export function noteKeyWaitGaveUp(channelId: string, now = Date.now()) {
    update(channelId, s => ({ ...s, gaveUpAt: now, gaveUpKeySeq: s.keyReceivedSeq }));
}

/** This device asked for the channel's keys while holding none (true), or the
 *  newest epoch has since been installed / the fast re-ask gave up (false). */
export function noteNewestKeyPending(channelId: string, pending: boolean) {
    if (!!getKeyWaitSignals(channelId).newestKeyPending === pending) return;
    update(channelId, s => ({ ...s, newestKeyPending: pending }));
}

/** Sign-out / tests. */
export function resetKeyWaitSignals() {
    byChannel.clear();
    for (const l of [...listeners]) l();
}
