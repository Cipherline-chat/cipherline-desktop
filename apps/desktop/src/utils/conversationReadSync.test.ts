import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
    parseConversationReadStates,
    mergeReadCursors,
    messageServerMs,
    isReadByCursor,
    reconcileDmUnread,
    parseSelfReadEvent,
    cursorsFromSelfReads,
} from './conversationReadSync';
import { reconcileChannelUnread, parseChannelReadEvent, clearCounts } from './channelReadSync';

/**
 * "I read a message on one PC and then go to my other PC, it still shows
 * unread." Device A reads; device B was offline/asleep (BOOT/RECONNECT cases)
 * or online (LIVE cases). Every scenario below is B's view.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const DM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DM2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const T = (s: string) => Date.parse(`2026-10-12T${s}.000Z`);
const msg = (id: string, at: string, from = PEER, type = 'text') =>
    ({ id, sender_user_id: from, content: { type }, server_ts: `2026-10-12T${at}.000Z`, timestamp: `2026-10-12T${at}.000Z` });

/** What Dashboard's incomingAfter closure does, over a thread map. */
const incomingAfterFor = (threads: Record<string, unknown[]>) => (id: string, cursorMs: number): number | null => {
    const thread = threads[id];
    if (!Array.isArray(thread) || thread.length === 0) return null;
    let n = 0;
    for (const m of thread) {
        const row = m as ReturnType<typeof msg> | null;
        if (!row || row.content?.type === 'system' || row.sender_user_id === ME) continue;
        const ms = messageServerMs(row);
        if (!Number.isFinite(ms) || ms > cursorMs) n++;
    }
    return n;
};

describe('parseConversationReadStates', () => {
    it('parses the server shape into epoch-ms cursors', () => {
        expect(parseConversationReadStates([{ conversation_id: DM, last_read_at: '2026-10-12T10:00:00.000Z' }]))
            .toEqual({ [DM]: T('10:00:00') });
    });
    it('drops malformed rows and non-arrays instead of coercing', () => {
        expect(parseConversationReadStates(null)).toEqual({});
        expect(parseConversationReadStates({})).toEqual({});
        expect(parseConversationReadStates([
            null, 'x', { conversation_id: 'nope', last_read_at: '2026-10-12T10:00:00.000Z' },
            { conversation_id: DM, last_read_at: 'yesterday' }, { conversation_id: DM, last_read_at: 5 },
            { conversation_id: DM2, last_read_at: '2026-10-12T11:00:00.000Z' },
        ])).toEqual({ [DM2]: T('11:00:00') });
    });
    it('keeps the later cursor for a duplicated id', () => {
        expect(parseConversationReadStates([
            { conversation_id: DM, last_read_at: '2026-10-12T12:00:00.000Z' },
            { conversation_id: DM, last_read_at: '2026-10-12T10:00:00.000Z' },
        ])).toEqual({ [DM]: T('12:00:00') });
    });
});

describe('mergeReadCursors — never rewinds', () => {
    it('advances, ignores older, and returns the SAME object for a no-op', () => {
        const prev = { [DM]: T('10:00:00') };
        expect(mergeReadCursors(prev, { [DM]: T('11:00:00') })).toEqual({ [DM]: T('11:00:00') });
        expect(mergeReadCursors(prev, { [DM]: T('09:00:00') })).toBe(prev);
        expect(mergeReadCursors(prev, {})).toBe(prev);
        expect(mergeReadCursors(prev, { [DM2]: NaN })).toBe(prev);
    });
});

describe('isReadByCursor — the one rule: read iff server time <= cursor', () => {
    const cursors = { [DM]: T('10:00:00') };
    it('at or before the cursor is read; after is unread', () => {
        expect(isReadByCursor(cursors, DM, msg('a', '09:59:59'))).toBe(true);
        expect(isReadByCursor(cursors, DM, msg('a', '10:00:00'))).toBe(true);
        expect(isReadByCursor(cursors, DM, msg('a', '10:00:01'))).toBe(false);
    });
    it('no cursor, or no usable timestamp, is NEVER read (fail toward showing unread)', () => {
        expect(isReadByCursor(cursors, DM2, msg('a', '01:00:00'))).toBe(false);
        expect(isReadByCursor(cursors, DM, { timestamp: 'garbage' })).toBe(false);
        expect(isReadByCursor(cursors, DM, {})).toBe(false);
    });
    it('prefers the envelope server time over the (clamped) display timestamp', () => {
        expect(isReadByCursor(cursors, DM, { server_ts: '2026-10-12T09:00:00.000Z', timestamp: '2026-10-12T11:00:00.000Z' })).toBe(true);
    });
});

describe('BOOT / RECONNECT — device B was offline while device A read', () => {
    it('clears a DM unread that A read, and a channel unread that A read, in the same seed', () => {
        // B's persisted badges from the last session: 2 in the DM (+1 mention), 3 in the channel.
        const unread = { [DM]: 2, [CH]: 3 };
        const mentions = { [DM]: 1, [CH]: 1 };
        // B's stored thread holds the DM messages it had already pulled.
        const threads = { [DM]: [msg('m1', '09:00:00'), msg('m2', '09:05:00')] };

        // Channel path: GET /servers/:sid/unread says 0 now (A advanced the cursor).
        const ch = reconcileChannelUnread({
            unread, mentions, rows: [{ channel_id: CH, unread_count: 0 }],
            unreadAtRequest: unread, mentionsAtRequest: mentions,
        });
        expect(ch.unread).toEqual({ [DM]: 2 });
        expect(ch.mentions).toEqual({ [DM]: 1 });

        // DM path: GET /conversations/read-states says A read through 09:30.
        const dm = reconcileDmUnread({
            unread, mentions, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: unread, mentionsAtRequest: mentions,
            incomingAfter: incomingAfterFor(threads),
        });
        expect(dm.unread).toEqual({ [CH]: 3 });
        expect(dm.mentions).toEqual({ [CH]: 1 });
    });

    it('NEGATIVE CONTROL: with the old code (no DM cursor at all) the DM stays lit', () => {
        // Pre-fix there was no read-states fetch and no reconcile for DMs: the
        // restored count simply survived. This is what the owner saw.
        const oldRule = (unread: Record<string, number>) => unread;
        expect(oldRule({ [DM]: 2 })).toEqual({ [DM]: 2 });
        // ...and the new rule is genuinely different on the same input.
        const out = reconcileDmUnread({
            unread: { [DM]: 2 }, mentions: {}, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: { [DM]: 2 }, mentionsAtRequest: {},
            incomingAfter: incomingAfterFor({ [DM]: [msg('m1', '09:00:00'), msg('m2', '09:05:00')] }),
        });
        expect(out.unread).toEqual({});
    });

    it('lowers only to what is genuinely newer than the cursor', () => {
        const threads = { [DM]: [msg('m1', '09:00:00'), msg('m2', '09:40:00'), msg('m3', '09:50:00')] };
        const out = reconcileDmUnread({
            unread: { [DM]: 3 }, mentions: { [DM]: 3 }, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: { [DM]: 3 }, mentionsAtRequest: { [DM]: 3 },
            incomingAfter: incomingAfterFor(threads),
        });
        expect(out.unread).toEqual({ [DM]: 2 });
        expect(out.mentions).toEqual({ [DM]: 2 }); // never above the unread number
    });

    it('never counts my own messages or system rows as unread', () => {
        const threads = { [DM]: [msg('m1', '09:40:00', ME), msg('s', '09:41:00', PEER, 'system')] };
        const out = reconcileDmUnread({
            unread: { [DM]: 2 }, mentions: {}, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: { [DM]: 2 }, mentionsAtRequest: {},
            incomingAfter: incomingAfterFor(threads),
        });
        expect(out.unread).toEqual({});
    });

    it('never RAISES, and leaves an unloaded thread alone (nothing is known)', () => {
        const a = reconcileDmUnread({
            unread: {}, mentions: {}, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: {}, mentionsAtRequest: {},
            incomingAfter: incomingAfterFor({ [DM]: [msg('m1', '10:00:00')] }),
        });
        expect(a.unread).toEqual({});
        const unread = { [DM]: 4 };
        const b = reconcileDmUnread({
            unread, mentions: {}, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: unread, mentionsAtRequest: {},
            incomingAfter: incomingAfterFor({}),
        });
        expect(b.unread).toBe(unread);
    });

    it('does not undo a message that arrived WHILE the request was in flight', () => {
        const out = reconcileDmUnread({
            unread: { [DM]: 3 }, mentions: {}, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: { [DM]: 2 }, mentionsAtRequest: {},
            incomingAfter: () => 0,
        });
        expect(out.unread).toEqual({ [DM]: 3 });
    });

    it('returns the SAME objects when nothing changes (no re-render)', () => {
        const unread = { [DM]: 1 };
        const mentions = {};
        const out = reconcileDmUnread({
            unread, mentions, cursors: { [DM]: T('09:30:00') },
            unreadAtRequest: unread, mentionsAtRequest: mentions,
            incomingAfter: () => 1,
        });
        expect(out.unread).toBe(unread);
        expect(out.mentions).toBe(mentions);
    });
});

describe('BOOT PULL — messages read elsewhere that this device only now pulls (poll-then-ACK)', () => {
    it('counts only the messages newer than the cursor, on the same server clock for both devices', () => {
        // A read through 10:00; B was asleep and pulls three envelopes at boot.
        const cursors = { [DM]: T('10:00:00') };
        const pulled = [msg('p1', '09:50:00'), msg('p2', '10:00:00'), msg('p3', '10:05:00')];
        const counted = pulled.filter(m => !isReadByCursor(cursors, DM, m));
        expect(counted.map(m => m.id)).toEqual(['p3']);
    });

    it('NEGATIVE CONTROL: the old pull counted all three', () => {
        const oldCounted = [msg('p1', '09:50:00'), msg('p2', '10:00:00'), msg('p3', '10:05:00')]; // no cursor filter
        expect(oldCounted).toHaveLength(3);
    });

    it('with no cursor yet (seed not landed) everything counts, and the later seed lowers it', () => {
        const pulled = [msg('p1', '09:50:00'), msg('p2', '10:05:00')];
        expect(pulled.filter(m => !isReadByCursor({}, DM, m))).toHaveLength(2);
        const out = reconcileDmUnread({
            unread: { [DM]: 2 }, mentions: {}, cursors: { [DM]: T('10:00:00') },
            unreadAtRequest: { [DM]: 2 }, mentionsAtRequest: {},
            incomingAfter: incomingAfterFor({ [DM]: pulled }),
        });
        expect(out.unread).toEqual({ [DM]: 1 });
    });
});

describe('LIVE — device B is online when A reads', () => {
    const dmRead = { conversation_id: DM, reader_user_id: ME, last_read_message_id: 'm', read_at: 1, last_read_at: '2026-10-12T10:00:00.000Z' };

    it('a message:read where the reader is ME is a self-read that clears my DM badge', () => {
        const ev = parseSelfReadEvent(dmRead, ME);
        expect(ev).not.toBeNull();
        expect(clearCounts({ [DM]: 2, [DM2]: 1 }, [ev!.conversation_id])).toEqual({ [DM2]: 1 });
    });

    it('a receipt from SOMEONE ELSE is not a self-read and clears nothing', () => {
        expect(parseSelfReadEvent({ ...dmRead, reader_user_id: PEER }, ME)).toBeNull();
    });

    it('fails closed: a missing id on either side is never a match', () => {
        expect(parseSelfReadEvent({ ...dmRead, reader_user_id: undefined }, ME)).toBeNull();
        expect(parseSelfReadEvent(dmRead, null)).toBeNull();
        expect(parseSelfReadEvent(dmRead, '')).toBeNull();
        expect(parseSelfReadEvent(null, ME)).toBeNull();
        expect(parseSelfReadEvent({ ...dmRead, conversation_id: 7 }, ME)).toBeNull();
    });

    it('a channel read reported through message:read (channel id as conversation_id) clears the channel too', () => {
        const ev = parseSelfReadEvent({ ...dmRead, conversation_id: CH }, ME)!;
        expect(clearCounts({ [CH]: 5 }, [ev.conversation_id])).toEqual({});
    });

    it('carries the server cursor so a later pull cannot recount what A already showed', () => {
        const ev = parseSelfReadEvent(dmRead, ME)!;
        const cursors = mergeReadCursors({}, cursorsFromSelfReads([ev]));
        expect(cursors[DM]).toBe(T('10:00:00'));
        expect(isReadByCursor(cursors, DM, msg('late', '09:59:00'))).toBe(true);
        expect(isReadByCursor(cursors, DM, msg('new', '10:01:00'))).toBe(false);
    });

    it('without a server cursor (older API) it still clears but advances nothing', () => {
        const older: Record<string, unknown> = { ...dmRead };
        delete older.last_read_at;
        const ev = parseSelfReadEvent(older, ME)!;
        expect(ev.last_read_at_ms).toBeUndefined();
        expect(cursorsFromSelfReads([ev])).toEqual({});
    });

    it('SEVERAL conversations read in one React batch ALL clear (a single slot kept only the last)', () => {
        const events = [DM, DM2].map(id => parseSelfReadEvent({ ...dmRead, conversation_id: id }, ME)!);
        const ids = events.map(e => e.conversation_id);
        expect(clearCounts({ [DM]: 1, [DM2]: 2, other: 3 }, ids)).toEqual({ other: 3 });
        // NEGATIVE CONTROL: the old single-slot state only ever saw the last event.
        const oldSlot = events[events.length - 1];
        expect(clearCounts({ [DM]: 1, [DM2]: 2, other: 3 }, [oldSlot.conversation_id])).toEqual({ [DM]: 1, other: 3 });
    });

    it('a live channel:read clears that channel for B (and ignores a malformed one)', () => {
        const ev = parseChannelReadEvent({ server_id: SID, channel_id: CH, last_read_at: '2026-10-12T10:00:00.000Z' });
        expect(ev).not.toBeNull();
        expect(clearCounts({ [CH]: 4 }, [ev!.channel_id])).toEqual({});
        expect(parseChannelReadEvent({ server_id: SID, channel_id: 'x', last_read_at: 'y' })).toBeNull();
    });
});

describe('wiring guards (Dashboard.tsx is not mountable under vitest, so scan the source)', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const dash = read('../components/Dashboard.tsx');
    const rt = read('../hooks/useRealtime.ts');

    it('the DM pull skips messages the cursor says were already read', () => {
        expect(dash).toMatch(/isReadByCursor\(dmReadCursorsRef\.current, cId, m\)\) continue;/);
    });
    it('the cursors are fetched on the first connection AND queued on every reconnect', () => {
        expect(dash).toContain('`${API_BASE}/conversations/read-states`');
        expect(dash).toMatch(/q\.add\(\(\) => seedDmReadStatesRef\.current\(\), P_BADGES\)/);
        expect(dash).toMatch(/dmReadSeededForRef/);
    });
    it('the stored history is reconciled against the cursors once it has loaded', () => {
        expect(dash).toMatch(/dmHistoryLoadedRef\.current = true;[\s\S]{0,700}reconcileDmUnreadRef\.current\(\)/);
    });
    it('self-read events are a drained queue, not a single slot', () => {
        expect(rt).toContain('const [selfReadEvents, setSelfReadEvents] = useState<SelfReadEvent[]>([]);');
        expect(rt).not.toMatch(/useState<\{\s*conversation_id: string;\s*last_read_message_id/);
        expect(dash).toMatch(/setSelfReadEvents\(\[\]\)/);
    });
});
