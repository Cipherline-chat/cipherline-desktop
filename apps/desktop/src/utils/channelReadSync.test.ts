import { describe, it, expect } from 'vitest';
import {
    parseChannelReadEvent,
    clearCounts,
    reconcileChannelUnread,
    shouldAdvanceChannelCursor,
} from './channelReadSync';

const SID = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const CH2 = '33333333-3333-4333-8333-333333333333';

describe('parseChannelReadEvent', () => {
    it('accepts the server shape', () => {
        expect(parseChannelReadEvent({ server_id: SID, channel_id: CH, last_read_at: '2026-10-03T10:00:00.000Z', device_id: null }))
            .toEqual({ server_id: SID, channel_id: CH, last_read_at: '2026-10-03T10:00:00.000Z' });
    });
    it.each([
        null, 'x', {},
        { server_id: SID, channel_id: 'not-a-uuid', last_read_at: '2026-10-03T10:00:00.000Z' },
        { server_id: SID, channel_id: CH, last_read_at: 'yesterday' },
        { server_id: SID, channel_id: CH, last_read_at: 123 },
        { channel_id: CH, last_read_at: '2026-10-03T10:00:00.000Z' },
    ])('drops a malformed payload %#', (bad) => {
        expect(parseChannelReadEvent(bad)).toBeNull();
    });
});

describe('clearCounts', () => {
    it('removes the ids and leaves the rest', () => {
        expect(clearCounts({ [CH]: 3, [CH2]: 1 }, [CH])).toEqual({ [CH2]: 1 });
    });
    it('returns the SAME object when nothing changes (no re-render for an echo)', () => {
        const counts = { [CH2]: 1 };
        expect(clearCounts(counts, [CH])).toBe(counts);
    });
});

describe('reconcileChannelUnread — the other-device read the old floor-only rule could never clear', () => {
    it('LOWERS a local count to the server\'s when nothing arrived locally meanwhile (read on the phone)', () => {
        const unread = { [CH]: 4 };
        const mentions = { [CH]: 1 };
        const out = reconcileChannelUnread({
            unread, mentions, rows: [{ channel_id: CH, unread_count: 0 }],
            unreadAtRequest: { [CH]: 4 }, mentionsAtRequest: { [CH]: 1 },
        });
        expect(out.unread).toEqual({});
        expect(out.mentions).toEqual({});
    });

    it('positive control: the old rule (raise only) would have left it lit', () => {
        // The pre-fix reconcile skipped every row with unread_count <= 0.
        const oldRule = (local: Record<string, number>, rows: { channel_id: string; unread_count: number }[]) => {
            const next = { ...local };
            for (const r of rows) {
                if (r.unread_count <= 0) continue;
                if (r.unread_count > (next[r.channel_id] ?? 0)) next[r.channel_id] = r.unread_count;
            }
            return next;
        };
        expect(oldRule({ [CH]: 4 }, [{ channel_id: CH, unread_count: 0 }])).toEqual({ [CH]: 4 });
    });

    it('never undoes a message that arrived WHILE the request was in flight', () => {
        const out = reconcileChannelUnread({
            unread: { [CH]: 5 }, mentions: { [CH]: 2 },
            rows: [{ channel_id: CH, unread_count: 0 }],
            unreadAtRequest: { [CH]: 4 }, mentionsAtRequest: { [CH]: 1 },
        });
        expect(out.unread).toEqual({ [CH]: 5 });
        expect(out.mentions).toEqual({ [CH]: 2 });
    });

    it('still RAISES (messages that arrived while this device was asleep) and reports which', () => {
        const out = reconcileChannelUnread({
            unread: { [CH]: 1 }, mentions: {},
            rows: [{ channel_id: CH, unread_count: 7 }, { channel_id: CH2, unread_count: 2 }],
            unreadAtRequest: { [CH]: 1 }, mentionsAtRequest: {},
        });
        expect(out.unread).toEqual({ [CH]: 7, [CH2]: 2 });
        expect(out.raised.sort()).toEqual([CH, CH2].sort());
    });

    it('lowers to a partial count (read some of them elsewhere) but keeps mentions it cannot judge', () => {
        const out = reconcileChannelUnread({
            unread: { [CH]: 6 }, mentions: { [CH]: 1 },
            rows: [{ channel_id: CH, unread_count: 2 }],
            unreadAtRequest: { [CH]: 6 }, mentionsAtRequest: { [CH]: 1 },
        });
        expect(out.unread).toEqual({ [CH]: 2 });
        expect(out.mentions).toEqual({ [CH]: 1 });
    });

    it('is a no-op (same objects) when the server agrees', () => {
        const unread = { [CH]: 2 };
        const mentions = {};
        const out = reconcileChannelUnread({
            unread, mentions, rows: [{ channel_id: CH, unread_count: 2 }, { channel_id: CH2, unread_count: 0 }],
            unreadAtRequest: unread, mentionsAtRequest: mentions,
        });
        expect(out.unread).toBe(unread);
        expect(out.mentions).toBe(mentions);
    });

    it('converges: two devices that both reconcile against the same server answer end with the same counts', () => {
        const rows = [{ channel_id: CH, unread_count: 0 }, { channel_id: CH2, unread_count: 3 }];
        const a = reconcileChannelUnread({ unread: { [CH]: 9 }, mentions: { [CH]: 1 }, rows, unreadAtRequest: { [CH]: 9 }, mentionsAtRequest: { [CH]: 1 } });
        const b = reconcileChannelUnread({ unread: { [CH2]: 1 }, mentions: {}, rows, unreadAtRequest: { [CH2]: 1 }, mentionsAtRequest: {} });
        expect(a.unread).toEqual(b.unread);
        expect(a.mentions).toEqual(b.mentions);
    });

    it('never lowers on a garbage count from the server', () => {
        const unread = { [CH]: 2 };
        for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '0' as unknown as number]) {
            const out = reconcileChannelUnread({
                unread, mentions: {},
                rows: [{ channel_id: CH, unread_count: bad }],
                unreadAtRequest: unread, mentionsAtRequest: {},
            });
            expect(out.unread).toBe(unread);
        }
    });
});

describe('shouldAdvanceChannelCursor', () => {
    const base = {
        messageChannelId: CH, activeChannelId: CH, activeChannelIsText: true,
        windowFocused: true, documentVisible: true, isOwnMessage: false,
    };
    it('advances when a human is looking at that channel', () => {
        expect(shouldAdvanceChannelCursor(base)).toBe(true);
    });
    it.each([
        ['another channel is open', { activeChannelId: CH2 }],
        ['the window is not focused', { windowFocused: false }],
        ['the window is hidden/minimised', { documentVisible: false }],
        ['it is my own message', { isOwnMessage: true }],
        ['the open channel is a calls channel', { activeChannelIsText: false }],
    ])('does not advance when %s', (_label, patch) => {
        expect(shouldAdvanceChannelCursor({ ...base, ...patch })).toBe(false);
    });
});
