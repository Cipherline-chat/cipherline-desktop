/**
 * F3 — channel edit / delete are authorized by the RECEIVER, not only by the
 * server's check of the client-declared action type.
 *
 * Negative: a member posting an ordinary message whose encrypted body is an
 * edit or delete of someone else's row changes nothing (the audit PoC), and a
 * sender-chosen client_msg_id cannot redirect an action onto another member's
 * row. Positive: authors edit/delete their own rows (from any of their
 * devices, incl. under a local client_msg_id), and a server-confirmed
 * moderator delete still removes someone else's row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    foldChannelHistory,
    deletedChannelTargetIds,
    applyChannelEditDelete,
    findChannelActionTarget,
    type ChannelRow,
} from './channelHistoryMerge';
import { applyOrphans } from './channelOrphanActions';

const ts = (m: number) => new Date(m * 60_000).toISOString();
const alice: ChannelRow = {
    id: 'row-1', timestamp: ts(1), sender_user_id: 'alice', sender_device_id: 'dA',
    content: { type: 'text', text: 'meet at 5', client_msg_id: 'cm-1' },
};
const action = (over: Partial<ChannelRow> & { content: unknown }): ChannelRow =>
    ({ id: 'act', timestamp: ts(2), ...over } as ChannelRow);

describe('F3 negative — another member cannot rewrite or erase a message', () => {
    it("Mallory's edit of Alice's message is ignored (audit PoC)", () => {
        const out = foldChannelHistory([alice], [action({ sender_user_id: 'mallory', sender_device_id: 'dM', content: { type: 'edit', target_id: 'row-1', text: 'wire the money to X' } })]);
        expect(out).toHaveLength(1);
        expect(out[0].content.text).toBe('meet at 5');
        expect(out[0].edited).toBeUndefined();
    });
    it("Mallory's delete of Alice's message is ignored (audit PoC, via client_msg_id)", () => {
        expect(foldChannelHistory([alice], [action({ sender_user_id: 'mallory', sender_device_id: 'dM', content: { type: 'delete', target_id: 'cm-1' } })])).toHaveLength(1);
        expect(deletedChannelTargetIds([alice], [action({ sender_user_id: 'mallory', content: { type: 'delete', target_id: 'row-1' } })])).toEqual([]);
    });
    it('a delete marker without a confirmed moderator delete is not applied live', () => {
        const thread = [alice];
        expect(applyChannelEditDelete(thread, action({ sender_user_id: 'mod', content: { type: 'delete', target_id: 'row-1' } }))).toBe(thread);
    });
    it('a moderator confirmation never authorizes an EDIT of someone else\'s message', () => {
        const thread = [alice];
        const out = applyChannelEditDelete(thread, action({ sender_user_id: 'mod', content: { type: 'edit', target_id: 'row-1', text: 'x' } }), { moderatorDeleteTargets: new Set(['row-1']) });
        expect(out).toBe(thread);
    });
    it("a client_msg_id equal to another member's target cannot pull an action onto that row", () => {
        // Mallory's own row reuses Bob's row id as its client_msg_id; Bob's
        // delete of his own row must remove only his row.
        const bob: ChannelRow = { id: 'row-b', timestamp: ts(1), sender_user_id: 'bob', content: { type: 'text', text: 'b' } };
        const mal: ChannelRow = { id: 'row-m', timestamp: ts(1), sender_user_id: 'mallory', content: { type: 'text', text: 'm', client_msg_id: 'row-b' } };
        const out = foldChannelHistory([bob, mal], [action({ sender_user_id: 'bob', content: { type: 'delete', target_id: 'row-b' } })]);
        expect(out.map(r => r.id)).toEqual(['row-m']);
        // …and Mallory cannot use her client_msg_id to aim at Bob's row.
        expect(findChannelActionTarget([bob], 'cm-x', action({ sender_user_id: 'mallory', content: {} }))).toBe(-1);
    });
    it('parked (orphan) actions go through the same authorization', () => {
        const out = applyOrphans([alice], [action({ sender_user_id: 'mallory', content: { type: 'edit', target_id: 'row-1', text: 'x' } })]);
        expect(out[0].content.text).toBe('meet at 5');
    });
});

describe('F3 positive controls', () => {
    it('Alice edits her own message from another of her devices', () => {
        const out = foldChannelHistory([alice], [action({ sender_user_id: 'alice', sender_device_id: 'dA2', content: { type: 'edit', target_id: 'row-1', text: 'meet at 6' } })]);
        expect(out[0].content.text).toBe('meet at 6');
        expect(out[0].edited).toBe(true);
    });
    it('Alice deletes her own message targeting its client_msg_id', () => {
        expect(foldChannelHistory([alice], [action({ sender_user_id: 'alice', content: { type: 'delete', target_id: 'cm-1' } })])).toHaveLength(0);
    });
    it('a server-confirmed moderator delete removes someone else\'s message (live path)', () => {
        const mod = action({ sender_user_id: 'mod', content: { type: 'delete', target_id: 'row-1' } });
        const opts = { moderatorDeleteTargets: new Set(['row-1']) };
        expect(applyChannelEditDelete([alice], mod, opts)).toHaveLength(0);
        expect(deletedChannelTargetIds([alice], [mod], new Set(), opts)).toEqual(['row-1']);
    });
    it('rows without a user id fall back to the server-labelled device', () => {
        const legacy: ChannelRow = { id: 'r', timestamp: ts(1), sender_device_id: 'd1', content: { type: 'text', text: 'a' } };
        expect(foldChannelHistory([legacy], [action({ sender_device_id: 'd1', content: { type: 'edit', target_id: 'r', text: 'b' } })])[0].content.text).toBe('b');
        expect(foldChannelHistory([legacy], [action({ sender_device_id: 'd2', content: { type: 'edit', target_id: 'r', text: 'b' } })])[0].content.text).toBe('a');
    });
});

describe('F3 wiring — the live channel path authorizes edits/deletes', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const start = src.indexOf('const handleChannelMessage = useCallback');
    const fn = src.slice(start, src.indexOf('}, [userId, notify, channelFailureContext]);', start));
    it('applies edit/delete through applyChannelEditDelete with server-confirmed moderator targets', () => {
        expect(start).toBeGreaterThan(0);
        expect(fn).toContain('confirmModeratorDeleteRef.current(');
        expect(fn).toContain('applyChannelEditDelete(thread, liveAction, { moderatorDeleteTargets })');
        expect(fn).toContain('{ moderatorDeleteTargets }');
        // The old unconditional filter is gone.
        expect(fn).not.toMatch(/thread\.filter\(t => t\.id !== content\.target_id && t\.content\?\.client_msg_id !== content\.target_id\)/);
    });
    it('confirms a moderator delete against the server tombstone', () => {
        const helper = src.slice(src.indexOf('const confirmModeratorDelete = useCallback'), src.indexOf('const confirmModeratorDeleteRef'));
        expect(helper).toContain('/channels/${channelId}/messages');
        expect(helper).toContain('row.deleted === true');
    });
});
