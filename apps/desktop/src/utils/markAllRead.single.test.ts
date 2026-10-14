import { describe, it, expect, vi } from 'vitest';
import { runMarkRead } from './markAllRead';
import type { CountMap } from './unreadBadges';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('runMarkRead — one conversation (sidebar "Mark as Read") through the same helper', () => {
    const msgs: Record<string, Array<{ id: string; content: { type: string } }>> = {
        c1: [{ id: U(1), content: { type: 'text' } }, { id: U(2), content: { type: 'text' } }],
        c2: [{ id: U(3), content: { type: 'text' } }],
        empty: [],
    };
    function run(over: Partial<Parameters<typeof runMarkRead>[0]> = {}, ids: string[] = ['c1']) {
        const state = { unread: { c1: 3, c2: 5, empty: 2 } as CountMap, mentions: { c1: 1, c2: 1 } as CountMap };
        const snap = { unread: { ...state.unread }, mentions: { ...state.mentions } };
        const send = vi.fn<(id: string, m: string, o?: { selfOnly?: boolean }) => boolean>(() => true);
        const notifyFailure = vi.fn();
        const p = runMarkRead({
            ids, unread: snap.unread, mentions: snap.mentions,
            setUnread: f => { state.unread = f(state.unread); },
            setMentions: f => { state.mentions = f(state.mentions); },
            messagesOf: id => msgs[id],
            isSelfChat: () => false, showReadReceipts: true, send, notifyFailure,
            ...over,
        });
        return { state, send, notifyFailure, p };
    }

    it('clears unread AND mentions for that conversation only, and calls the sender once with the newest message', async () => {
        const r = run();
        await r.p;
        expect(r.state.unread).toEqual({ c2: 5, empty: 2 });
        expect(r.state.mentions).toEqual({ c2: 1 });
        expect(r.send).toHaveBeenCalledTimes(1);
        expect(r.send).toHaveBeenCalledWith('c1', U(2), undefined);
    });

    it('receipts off -> self_only; self chat -> self_only', async () => {
        const off = run({ showReadReceipts: false });
        await off.p;
        expect(off.send).toHaveBeenCalledWith('c1', U(2), { selfOnly: true });
        const self = run({ isSelfChat: () => true });
        await self.p;
        expect(self.send).toHaveBeenCalledWith('c1', U(2), { selfOnly: true });
    });

    it('rolls back (unread + mentions) and notifies once when the send fails', async () => {
        const r = run({ send: vi.fn(() => false) });
        await r.p;
        expect(r.state.unread).toEqual({ c1: 3, c2: 5, empty: 2 });
        expect(r.state.mentions).toEqual({ c1: 1, c2: 1 });
        expect(r.notifyFailure).toHaveBeenCalledTimes(1);
        expect(r.notifyFailure.mock.calls[0][0]).toContain('1 conversation');
    });

    it('no loaded message: nothing is sent, the local clear stands, no failure', async () => {
        const r = run({}, ['empty']);
        await r.p;
        expect(r.send).not.toHaveBeenCalled();
        expect(r.state.unread).toEqual({ c1: 3, c2: 5 });
        expect(r.notifyFailure).not.toHaveBeenCalled();
    });

    it('negative control: a conversation not asked for is neither cleared nor sent', async () => {
        const r = run();
        await r.p;
        expect(r.send).not.toHaveBeenCalledWith('c2', expect.anything(), expect.anything());
        expect(r.state.unread.c2).toBe(5);
        expect(r.state.mentions.c2).toBe(1);
    });
});
