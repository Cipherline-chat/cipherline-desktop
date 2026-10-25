import { describe, it, expect } from 'vitest';
import { buildKnownConversations } from './useComposerDraftPrune';
import { pruneToKnown, draftKey, type DraftMap } from '../utils/composerDrafts';

const drafts: DraftMap = {
    [draftKey('dm', 'c1')]: { t: 'a', at: 1 },
    [draftKey('ch', 'ch1')]: { t: 'b', at: 1, s: 's1' },
    [draftKey('ch', 'ch2')]: { t: 'c', at: 1, s: 's1' },
};

describe('buildKnownConversations', () => {
    it('lists what is loaded', () => {
        const k = buildKnownConversations({
            conversations: [{ conversation_id: 'c1' }], servers: [{ server_id: 's1' }],
            serverChannels: { s1: [{ channel_id: 'ch1' }] }, serversLoaded: true,
        });
        expect([...k.dmIds!]).toEqual(['c1']);
        expect([...k.serverIds!]).toEqual(['s1']);
        expect([...k.channelIdsByServer.s1!]).toEqual(['ch1']);
        expect(Object.keys(pruneToKnown(drafts, k))).toEqual([draftKey('dm', 'c1'), draftKey('ch', 'ch1')]);
    });

    it('an empty conversation list (a failed fetch looks the same) prunes nothing', () => {
        const k = buildKnownConversations({ conversations: [], servers: [], serverChannels: {}, serversLoaded: true });
        expect(k.dmIds).toBeNull();
        expect(k.serverIds).toBeNull();
        expect(Object.keys(pruneToKnown(drafts, k))).toHaveLength(3);
    });

    it('servers still loading: server and channel lists are ignored entirely', () => {
        const k = buildKnownConversations({
            conversations: [{ conversation_id: 'c1' }], servers: [{ server_id: 's1' }],
            serverChannels: { s1: [{ channel_id: 'ch1' }] }, serversLoaded: false,
        });
        expect(k.serverIds).toBeNull();
        expect(k.channelIdsByServer).toEqual({});
        expect(Object.keys(pruneToKnown(drafts, k))).toContain(draftKey('ch', 'ch2'));
    });

    it('a server whose channel list is empty/unloaded keeps its drafts', () => {
        const k = buildKnownConversations({
            conversations: [{ conversation_id: 'c1' }], servers: [{ server_id: 's1' }],
            serverChannels: { s1: [] }, serversLoaded: true,
        });
        expect(k.channelIdsByServer.s1).toBeNull();
        expect(Object.keys(pruneToKnown(drafts, k))).toContain(draftKey('ch', 'ch2'));
    });
});

// The regression that lost every DM / group draft: the hook read `c.id`, but
// Dashboard's conversation rows are keyed `conversation_id`, so the "known DM
// ids" set came out EMPTY and the first prune after the list loaded deleted
// every dm: draft (server-channel drafts were unaffected).
describe('DM / group drafts survive the prune (Dashboard row shape)', () => {
    const dashboardRows = [
        { conversation_id: 'c1', type: 'dm', other_user_id: 'u2', title: 'bob' },
        { conversation_id: 'g1', type: 'group', title: 'the group' },
    ];
    const map: DraftMap = {
        [draftKey('dm', 'c1')]: { t: 'dm draft', at: 1 },
        [draftKey('dm', 'g1')]: { t: 'group draft', at: 1 },
        [draftKey('dm', 'removed')]: { t: 'gone', at: 1 },
        [draftKey('ch', 'ch1')]: { t: 'channel draft', at: 1, s: 's1' },
    };

    it('keeps DM and group drafts for listed conversations, drops removed ones', () => {
        const k = buildKnownConversations({
            conversations: dashboardRows, servers: [{ server_id: 's1' }],
            serverChannels: { s1: [{ channel_id: 'ch1' }] }, serversLoaded: true,
        });
        expect(Object.keys(pruneToKnown(map, k)).sort()).toEqual(
            [draftKey('ch', 'ch1'), draftKey('dm', 'c1'), draftKey('dm', 'g1')].sort());
    });

    it('a non-empty list that yields no ids is unknown, not "everything is gone"', () => {
        const k = buildKnownConversations({
            conversations: [{} as { conversation_id?: string }], servers: [], serverChannels: {}, serversLoaded: false,
        });
        expect(k.dmIds).toBeNull();
        expect(Object.keys(pruneToKnown(map, k))).toHaveLength(4);
    });
});
