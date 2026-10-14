import { describe, it, expect } from 'vitest';
import {
    aggregateServerStorage, sumServerStorage, planServerPurge, countServerPurge, isServerPurgeable,
    describePurgeResult, SERVER_PURGE_WARNING, LEFT_SERVER_PURGE_WARNING, UNKNOWN_ROW_KEY,
    type StorageServer, type StorageChannel,
} from './serverStorage';
import { calcConversationStorage } from './storageCalc';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

const text = (id: string, ageDays: number, body = id) => ({
    id, timestamp: NOW - ageDays * DAY, content: { type: 'text', text: body },
});
const file = (id: string, att: string, ageDays: number, bytes = 1000) => ({
    id, timestamp: NOW - ageDays * DAY,
    content: { type: 'attachment', attachment_id: att, filename: `${att}.png`, byte_size: bytes },
});

const ids = (a: unknown[]) => a.map(m => (m as { id: string }).id);
const srv = (id: string, name = id): StorageServer => ({ server_id: id, name });
const ch = (id: string, name = id): StorageChannel => ({ channel_id: id, name });

/** Two servers + a DM-sized decoy, so "exactly that server" is checkable. */
function world() {
    const channelMessages: Record<string, unknown[]> = {
        a1: [text('a1-old', 400), text('a1-new', 1), file('a1-file', 'att-a1', 400, 5000)],
        a2: [text('a2-old', 40), text('a2-new', 2)],
        b1: [text('b1-old', 400), text('b1-new', 1)],
        gone1: [text('g-old', 100)],
    };
    return {
        servers: [srv('A', 'Alpha'), srv('B', 'Beta')],
        serverChannels: { A: [ch('a1', 'general'), ch('a2', 'random')], B: [ch('b1', 'chat')] },
        channelMessages,
    };
}

describe('aggregateServerStorage', () => {
    it('sums each joined server over its own channels only, via the same sizing as DMs', () => {
        const w = world();
        const rows = aggregateServerStorage({ ...w, serverListComplete: false });
        const a = rows.find(r => r.serverId === 'A')!;
        const expected = ['a1', 'a2'].map(id => calcConversationStorage(id, w.channelMessages[id]));
        expect(a.messageCount).toBe(5);
        expect(a.attachmentCount).toBe(1);
        expect(a.attachmentBytes).toBe(5000);
        expect(a.totalBytes).toBe(expected[0].totalBytes + expected[1].totalBytes);
        expect(a.textBytes).toBe(expected[0].textBytes + expected[1].textBytes);
        expect(a.channelIds).toEqual(['a1', 'a2']);
        const b = rows.find(r => r.serverId === 'B')!;
        expect(b.messageCount).toBe(2);
        expect(b.channelIds).toEqual(['b1']);
    });

    it('lists every joined server, even with no local data, biggest first', () => {
        const w = world();
        const rows = aggregateServerStorage({
            ...w,
            servers: [...w.servers, srv('Z', 'Empty')],
            serverChannels: { ...w.serverChannels, Z: [ch('z1')] },
            serverListComplete: false,
        });
        expect(rows.map(r => r.name)).toEqual(['Alpha', 'Beta', 'Empty']);
        const z = rows[2];
        expect(z.totalBytes).toBe(0);
        expect(z.messageCount).toBe(0);
        expect(z.channelsKnown).toBe(true);
    });

    it('marks a server whose channel list has not loaded, and withholds Left/Other rows meanwhile', () => {
        const w = world();
        const rows = aggregateServerStorage({ ...w, serverChannels: { A: w.serverChannels.A } });
        expect(rows.find(r => r.serverId === 'B')!.channelsKnown).toBe(false);
        // gone1 might be B's - it must not be offered as an orphan yet.
        expect(rows.some(r => r.kind !== 'joined')).toBe(false);
    });

    it('shows a Left server (named by its cached channels) only while it still has local data', () => {
        const w = world();
        const left = { L: [ch('gone1', 'lobby'), ch('gone2', 'empty-one')] };
        const rows = aggregateServerStorage({ ...w, leftServerChannels: left });
        const l = rows.find(r => r.kind === 'left')!;
        expect(l.serverId).toBe('L');
        expect(l.name).toBe('Left server');
        expect(l.channelIds).toEqual(['gone1']);        // gone2 has no data: not listed
        expect(l.channelNames).toEqual(['lobby']);
        expect(l.messageCount).toBe(1);
        expect(rows.some(r => r.kind === 'unknown')).toBe(false);

        // Purged empty -> the row disappears.
        const drained = aggregateServerStorage({ ...w, channelMessages: { ...w.channelMessages, gone1: [] }, leftServerChannels: left });
        expect(drained.some(r => r.kind === 'left')).toBe(false);
    });

    it('groups threads that map to no known server into one Other row', () => {
        const w = world();
        const rows = aggregateServerStorage(w);
        const o = rows.find(r => r.kind === 'unknown')!;
        expect(o.rowKey).toBe(UNKNOWN_ROW_KEY);
        expect(o.channelIds).toEqual(['gone1']);
    });

    it('never double counts: a rejoined server is a joined row, not a Left one', () => {
        const w = world();
        const rows = aggregateServerStorage({
            ...w,
            leftServerChannels: { A: [ch('a1'), ch('a2')] },     // stale cache for a server we are in again
        });
        expect(rows.filter(r => r.serverId === 'A')).toHaveLength(1);
        const total = sumServerStorage(rows);
        const all = Object.values(w.channelMessages).reduce((n, m) => n + m.length, 0);
        expect(total.messageCount).toBe(all);
    });

    it('handles zero servers and an empty cache', () => {
        expect(aggregateServerStorage({ servers: [], serverChannels: {}, channelMessages: {} })).toEqual([]);
        expect(sumServerStorage([])).toEqual({ totalBytes: 0, messageCount: 0 });
    });

    it('does not claim one channel for two servers if a payload lists it twice', () => {
        const rows = aggregateServerStorage({
            servers: [srv('A'), srv('B')],
            serverChannels: { A: [ch('x')], B: [ch('x')] },
            channelMessages: { x: [text('m', 1)] },
        });
        expect(sumServerStorage(rows).messageCount).toBe(1);
    });
});

describe('planServerPurge - exactly the named channels, nothing else', () => {
    it('purges only the given channels; other servers and unrelated threads are untouched', () => {
        const w = world();
        const dm = { 'dm-1': [text('dm', 900)] };
        const all = { ...w.channelMessages, ...dm };
        const plan = planServerPurge({ channelMessages: all, channelIds: ['a1', 'a2'], olderThanMs: 0, now: NOW });
        expect(Object.keys(plan.next).sort()).toEqual(['a1', 'a2']);
        expect(plan.next.a1).toEqual([]);
        expect(plan.next.a2).toEqual([]);
        expect(plan.count).toBe(5);
        expect(plan.purgedIds).toEqual({ a1: ['a1-old', 'a1-new', 'a1-file'], a2: ['a2-old', 'a2-new'] });
    });

    it('honours the age window per message and reports only changed channels', () => {
        const w = world();
        const plan = planServerPurge({ channelMessages: w.channelMessages, channelIds: ['a1', 'a2'], olderThanMs: 30 * DAY, now: NOW });
        expect(ids(plan.next.a1)).toEqual(['a1-new']);     // 400d text + 400d file gone
        expect(ids(plan.next.a2)).toEqual(['a2-new']);     // 40d gone, 2d kept
        expect(plan.count).toBe(3);

        const noop = planServerPurge({ channelMessages: w.channelMessages, channelIds: ['a1'], olderThanMs: 1000 * DAY, now: NOW });
        expect(noop.next).toEqual({});
        expect(noop.count).toBe(0);
    });

    it('keeps pinned / saved messages and the account-wide saved attachments', () => {
        const w = world();
        const plan = planServerPurge({
            channelMessages: w.channelMessages,
            channelIds: ['a1'],
            olderThanMs: 0,
            protectedIdsFor: cid => (cid === 'a1' ? new Set(['a1-old']) : undefined),
            protectedAttachmentIds: new Set(['att-a1']),
            now: NOW,
        });
        expect(ids(plan.next.a1)).toEqual(['a1-old', 'a1-file']);
        expect(plan.purgedIds.a1).toEqual(['a1-new']);          // only what was dropped is tombstoned
        expect(plan.attachmentIds).toEqual([]);                 // the saved file's blob stays
        expect(plan.count).toBe(1);
    });

    it('returns the attachment ids of dropped files, once each, for blob cleanup', () => {
        const msgs = { c: [file('f1', 'att-1', 5), file('f2', 'att-1', 5), file('f3', 'att-2', 5), text('t', 5)] };
        const plan = planServerPurge({ channelMessages: msgs, channelIds: ['c'], olderThanMs: 0, now: NOW });
        expect(plan.attachmentIds.sort()).toEqual(['att-1', 'att-2']);
    });

    it('keeps unsent rows, in-flight sends and control rows', () => {
        const msgs = {
            c: [
                { id: 'p', _pending: true, timestamp: NOW - 900 * DAY, content: { type: 'text', text: 'x' } },
                { id: 's', send_state: 'sending', timestamp: NOW - 900 * DAY, content: { type: 'text', text: 'x' } },
                { id: 'e', timestamp: NOW - 900 * DAY, content: { type: 'edit', target_id: 't', text: 'y' } },
                { id: 'r', timestamp: NOW - 900 * DAY, content: { type: 'reaction', target_id: 't', emoji: ':)', action: 'add' } },
                { id: 'f', send_state: 'failed', timestamp: NOW - 900 * DAY, content: { type: 'text', text: 'x' } },
                text('t', 900),
            ],
        };
        const plan = planServerPurge({ channelMessages: msgs, channelIds: ['c'], olderThanMs: 0, now: NOW });
        expect(ids(plan.next.c)).toEqual(['p', 's', 'e', 'r']);
        expect(plan.count).toBe(2);
    });

    it('tolerates a channel with no cache and a duplicated channel id', () => {
        const w = world();
        const plan = planServerPurge({ channelMessages: w.channelMessages, channelIds: ['nope', 'b1', 'b1'], olderThanMs: 0, now: NOW });
        expect(plan.count).toBe(2);
        expect(Object.keys(plan.next)).toEqual(['b1']);
    });

    it('does not mutate its input', () => {
        const w = world();
        const before = JSON.stringify(w.channelMessages);
        planServerPurge({ channelMessages: w.channelMessages, channelIds: ['a1', 'a2', 'b1'], olderThanMs: 0, now: NOW });
        expect(JSON.stringify(w.channelMessages)).toBe(before);
    });
});

describe('countServerPurge matches what planServerPurge deletes (the confirm count is honest)', () => {
    const windows = [0, 7 * DAY, 30 * DAY, 182 * DAY, 365 * DAY];
    it.each(windows)('window %d', (ms) => {
        const w = world();
        const input = {
            channelMessages: w.channelMessages,
            channelIds: ['a1', 'a2'],
            olderThanMs: ms,
            protectedIdsFor: (cid: string) => (cid === 'a2' ? new Set(['a2-old']) : undefined),
            now: NOW,
        };
        expect(countServerPurge(input)).toBe(planServerPurge(input).count);
    });

    it('isServerPurgeable treats undefined / null rows as not purgeable', () => {
        expect(isServerPurgeable(undefined, 0, NOW)).toBe(false);
        expect(isServerPurgeable(null, 0, NOW)).toBe(false);
    });
});

describe('copy', () => {
    it('server confirm text says what is true for server history', () => {
        expect(SERVER_PURGE_WARNING).toMatch(/this device only/);
        expect(SERVER_PURGE_WARNING).toMatch(/other members/);
        expect(SERVER_PURGE_WARNING).toMatch(/Pinned and saved messages are kept/);
        expect(SERVER_PURGE_WARNING).toMatch(/not downloaded again/);
        // Not the DM wording, which talks about recipients.
        expect(SERVER_PURGE_WARNING).not.toMatch(/recipients/);
    });

    it('left-server confirm text does not promise what cannot be checked', () => {
        expect(LEFT_SERVER_PURGE_WARNING).toMatch(/no longer in this server/);
        expect(LEFT_SERVER_PURGE_WARNING).toMatch(/can’t be checked/);
        expect(LEFT_SERVER_PURGE_WARNING).toMatch(/Other members keep their copies/);
        expect(LEFT_SERVER_PURGE_WARNING).not.toMatch(/Pinned and saved messages are kept/);
    });

    it('describes the outcome, including a partial one', () => {
        expect(describePurgeResult({ purged: 1, skippedChannels: 0 })).toEqual({ tone: 'ok', text: 'Removed 1 message from this device.' });
        expect(describePurgeResult({ purged: 1200, skippedChannels: 0 }).text).toContain('1,200 messages');
        expect(describePurgeResult({ purged: 0, skippedChannels: 0 }).text).toBe('Nothing was removed.');
        const warn = describePurgeResult({ purged: 4, skippedChannels: 2 });
        expect(warn.tone).toBe('warn');
        expect(warn.text).toContain('2 channels skipped');
    });
});
