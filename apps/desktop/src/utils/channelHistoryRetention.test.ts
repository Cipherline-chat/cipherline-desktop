import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => {
    const store = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    };
    return { default: store, secureLocalStore: store };
});

const { getPurgedMessageIds, markMessagesPurged } = await import('./retentionTombstones');
const { sweepRetention } = await import('./retentionSweeper');
const { splitExpiredIncoming, pageNeedsKeyRequest } = await import('./channelHistoryRetention');
const { foldChannelHistory, coveredServerWindow, isUndecryptablePlaceholder } = await import('./channelHistoryMerge');
import type { StoragePolicy } from '../hooks/useRetentionPolicy';
import type { ChannelRow } from './channelHistoryMerge';

type Row = ChannelRow & { conversation_id?: string };

/**
 * The owner-reported symptom: a server with a short "Keep for" window, messages
 * age out, and the channel shows "Couldn't decrypt - waiting on this channel's
 * key" (and the key-request machinery wakes up) for messages that were deleted
 * ON PURPOSE.
 *
 * The server keeps a channel's rows for 30 days regardless of this device's
 * window, and hands them all back on every history fetch. So with a 1-week
 * window, most of what comes back is already expired and - on a device that
 * never held them, or whose epoch keys have aged out - cannot be decrypted.
 * These tests drive the same functions Dashboard's refreshChannelHistory /
 * sweep / loadOlder use, in the same order.
 */

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const U = 'user-1';
const CH = 'chan-1';

const policy = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    messageRetention: '1wk',
    attachmentRetention: '1wk',
    savedMessageIds: [],
    unsavedMessageIds: [],
    savedAttachmentIds: [],
    unsavedAttachmentIds: [],
    unsavedMessageTimestamps: {},
    unsavedAttachmentTimestamps: {},
    ...over,
} as StoragePolicy);

/** A row as decryptChannelRow returns it. `readable` = the epoch key is held. */
const serverRow = (id: string, ageDays: number, readable: boolean, now = T0): Row => ({
    id,
    timestamp: new Date(now - ageDays * DAY).toISOString(),
    sender_user_id: 'someone',
    sender_device_id: 'dev',
    conversation_id: CH,
    content: readable
        ? { type: 'text', text: `body ${id}` }
        : { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } },
});


/** What the server returns: 10 rows, newest first in age order. Keys for anything
 *  older than 10 days have aged out of this device's store. */
const SERVER_ROWS = [
    ['m1', 1], ['m2', 2], ['m3', 3],            // inside a 1-week window, readable
    ['m4', 10], ['m5', 12], ['m6', 15],         // past it, key pruned
    ['m7', 20], ['m8', 25], ['m9', 28], ['m10', 29],
].map(([id, age]) => serverRow(id as string, age as number, (age as number) < 10));

const noPins = new Set<string>();

beforeEach(() => mem.clear());

describe('ingest filter: rows already past retention never enter the cache', () => {
    it('a fresh device gets only the unexpired rows - no pills, no key request', () => {
        const { kept } = splitExpiredIncoming(SERVER_ROWS, { policy: policy(), pinned: noPins, now: T0 });
        expect(kept.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);

        const folded = foldChannelHistory([], kept, new Set(), coveredServerWindow(SERVER_ROWS, new Date(T0).toISOString()));
        expect(folded.map(m => m.id)).toEqual(['m3', 'm2', 'm1']);
        expect(folded.some(isUndecryptablePlaceholder)).toBe(false);
        expect(pageNeedsKeyRequest(kept, new Set())).toBe(false);
    });

    it('POSITIVE CONTROL: without the filter the same fetch yields six pills and asks for a key', () => {
        const folded = foldChannelHistory([], SERVER_ROWS, new Set(), undefined);
        expect(folded.filter(isUndecryptablePlaceholder)).toHaveLength(7);
        expect(pageNeedsKeyRequest(SERVER_ROWS, new Set())).toBe(true);
    });

    it('a pinned / server-saved row past the window is still ingested (and its pill, if any, still asks for a key)', () => {
        const { kept } = splitExpiredIncoming(SERVER_ROWS, { policy: policy(), pinned: new Set(['m5']), now: T0 });
        expect(kept.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm5']);
        // m5 is a saved message we genuinely cannot read: that IS a key problem worth reporting.
        expect(pageNeedsKeyRequest(kept, new Set())).toBe(true);
    });

    it('a per-server override is honoured: 1 month keeps everything here', () => {
        const { kept } = splitExpiredIncoming(SERVER_ROWS, { policy: policy({ messageRetention: '1mo' }), pinned: noPins, now: T0 });
        expect(kept).toHaveLength(10);
    });

    it('"keep forever" and a not-yet-chosen policy (null) drop nothing', () => {
        expect(splitExpiredIncoming(SERVER_ROWS, { policy: policy({ messageRetention: 'never' }), pinned: noPins, now: T0 }).expired).toEqual([]);
        expect(splitExpiredIncoming(SERVER_ROWS, null).kept).toHaveLength(10);
    });

    it('edit / delete / reaction rows pass through so they can still be folded onto a kept target', () => {
        const edit = { id: 'e1', timestamp: new Date(T0 - 20 * DAY).toISOString(), content: { type: 'edit', target_id: 'm1', text: 'x' } };
        const { kept } = splitExpiredIncoming([edit, ...SERVER_ROWS], { policy: policy(), pinned: noPins, now: T0 });
        expect(kept.map(m => m.id)).toContain('e1');
    });
});

describe('sweep -> refetch round trip: what the owner sees', () => {
    /** Run the sweep exactly as Dashboard does: tombstone first, then replace the thread. */
    const sweep = (thread: Row[], now: number, pol = policy(), pinned = noPins) => {
        const out = sweepRetention({ [CH]: thread }, pol, now, { [CH]: pinned });
        markMessagesPurged(U, CH, out.purgedMessageIds[CH] ?? []);
        return out.prunedState[CH];
    };
    /** Refetch exactly as refreshChannelHistory does. */
    const refetch = (thread: Row[], serverRows: Row[], now: number, pol = policy()) => {
        const { kept } = splitExpiredIncoming(serverRows, { policy: pol, pinned: noPins, now });
        const purged = getPurgedMessageIds(U, CH);
        const window = coveredServerWindow(serverRows, new Date(now).toISOString());
        return {
            thread: foldChannelHistory(thread, kept, purged, window),
            needsKey: pageNeedsKeyRequest(kept, purged),
        };
    };

    it('N messages -> sweep expires some -> refetch returns the same server rows -> only the unexpired remain', () => {
        // Day 0: everything readable, all 10 rows cached (keys held then), 1-month window.
        const readableAll = SERVER_ROWS.map(r => ({ ...r, content: { type: 'text', text: `body ${r.id}` } }));
        const month = policy({ messageRetention: '1mo' });
        let thread = refetch([], readableAll, T0, month).thread;
        expect(thread).toHaveLength(10);

        // The owner shortens to 1 week; the sweep runs on the same day.
        thread = sweep(thread, T0, policy());
        expect(thread.map(m => m.id).sort()).toEqual(['m1', 'm2', 'm3']);

        // The server still holds all 10 rows. Seven of them can no longer be
        // decrypted (the epoch keys aged out), so refetch sees pills for them.
        const r = refetch(thread, SERVER_ROWS, T0);
        expect(r.thread.map(m => m.id).sort()).toEqual(['m1', 'm2', 'm3']);
        expect(r.thread.some(isUndecryptablePlaceholder)).toBe(false);
        expect(r.needsKey).toBe(false);
    });

    it('still correct a week later: rows age out one by one and none comes back as a pill', () => {
        let thread = refetch([], SERVER_ROWS, T0).thread;                 // m3, m2, m1 (3, 2, 1 days old)
        const later = T0 + 5 * DAY;                                        // they are now 8, 7, 6 days old
        thread = sweep(thread, later);
        // m1 (6 days) is inside the 7-day window; m2 is exactly on it and goes.
        expect(thread.map(m => m.id)).toEqual(['m1']);

        // The server still returns every row; the ones that aged out must not return.
        const r = refetch(thread, SERVER_ROWS, later);
        expect(r.thread.map(m => m.id)).toEqual(['m1']);
        expect(r.thread.some(isUndecryptablePlaceholder)).toBe(false);
        expect(r.needsKey).toBe(false);
    });

    it('survives the tombstone ledger being empty or rolled over (the door filter does not depend on it)', () => {
        let thread = refetch([], SERVER_ROWS, T0).thread;
        thread = sweep(thread, T0 + 6 * DAY);                              // m1 (7d) expires, m2/m3 older too
        mem.clear();                                                       // ledger lost / device-local rollover
        const r = refetch(thread, SERVER_ROWS, T0 + 6 * DAY);
        expect(r.thread.every(m => !isUndecryptablePlaceholder(m))).toBe(true);
        expect(r.needsKey).toBe(false);
        // At T0+6d every row is 7+ days old: the thread is empty, not full of pills.
        expect(r.thread).toEqual([]);
    });

    it('"Load older history": a page entirely past retention contributes nothing', () => {
        const olderPage = SERVER_ROWS.slice(3);                            // m4..m10, all > 7 days, all unreadable
        const { kept } = splitExpiredIncoming(olderPage, { policy: policy(), pinned: noPins, now: T0 });
        expect(kept).toEqual([]);
        expect(pageNeedsKeyRequest(kept, new Set())).toBe(false);
    });

    it('a message deleted by retention never reappears from the live path either (ledger)', () => {
        const thread = sweep(refetch([], SERVER_ROWS, T0).thread, T0 + 30 * DAY);
        expect(thread).toEqual([]);
        expect(getPurgedMessageIds(U, CH).has('m1')).toBe(true);
    });
});
