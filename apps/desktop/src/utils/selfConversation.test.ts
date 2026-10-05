import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildDmPickerResults,
    chatAffordances,
    isSelfDm,
    isSilentIncoming,
    labelSelfConversations,
    selfConversationTitle,
    selfMatchesQuery,
} from './selfConversation';

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FRIEND = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('selfConversationTitle', () => {
    it('is "<name> (You)"', () => expect(selfConversationTitle('dawson')).toBe('dawson (You)'));
    it('degrades to "You" for a blank name', () => expect(selfConversationTitle('  ')).toBe('You'));
});

describe('isSelfDm', () => {
    it('recognises the server flag', () => {
        expect(isSelfDm({ type: 'dm', is_self: true }, ME)).toBe(true);
    });
    it('recognises a chat whose other_user_id is your own id (the activeChat shape)', () => {
        expect(isSelfDm({ type: 'dm', other_user_id: ME }, ME)).toBe(true);
    });
    it('NEGATIVE: an ordinary DM is not self', () => {
        expect(isSelfDm({ type: 'dm', other_user_id: FRIEND, is_self: false }, ME)).toBe(false);
    });
    it('NEGATIVE: a DM whose partner deleted their account (no other_user_id) is not self', () => {
        expect(isSelfDm({ type: 'dm', other_user_id: null }, ME)).toBe(false);
        expect(isSelfDm({ type: 'dm' }, ME)).toBe(false);
    });
    it('NEGATIVE: a group is never self, even if it somehow carried the flag', () => {
        expect(isSelfDm({ type: 'group', is_self: true }, ME)).toBe(false);
    });
    it('NEGATIVE: with no signed-in id nothing is inferred from other_user_id', () => {
        expect(isSelfDm({ type: 'dm', other_user_id: ME }, null)).toBe(false);
        expect(isSelfDm(null, ME)).toBe(false);
    });
});

describe('labelSelfConversations', () => {
    const rows = [
        { conversation_id: 'c1', type: 'dm', title: 'dawson', other_user_id: ME, is_self: true },
        { conversation_id: 'c2', type: 'dm', title: 'sam', other_user_id: FRIEND, is_self: false },
        { conversation_id: 'c3', type: 'dm', title: 'Unknown User', other_user_id: null, is_self: false },
        { conversation_id: 'c4', type: 'group', title: 'the crew', other_user_id: null },
    ];

    it('labels only the self row', () => {
        const out = labelSelfConversations(rows, ME);
        expect(out.map(r => r.title)).toEqual(['dawson (You)', 'sam', 'Unknown User', 'the crew']);
    });
    it('returns every other row by reference and does not mutate the input', () => {
        const snapshot = JSON.stringify(rows);
        const out = labelSelfConversations(rows, ME);
        expect(out[1]).toBe(rows[1]);
        expect(out[2]).toBe(rows[2]);
        expect(JSON.stringify(rows)).toBe(snapshot);
    });
    it('is idempotent (re-labelling an already-labelled list never stacks "(You) (You)")', () => {
        const once = labelSelfConversations(rows, ME);
        expect(labelSelfConversations(once, ME)[0].title).toBe('dawson (You)');
    });
    it('NEGATIVE: a deleted-partner DM is never relabelled as yourself', () => {
        expect(labelSelfConversations([rows[2]], ME)[0].title).toBe('Unknown User');
    });
});

describe('selfMatchesQuery — you appear in a search only when searched for', () => {
    it('empty / blank search never lists you (the self chat is not pre-listed)', () => {
        expect(selfMatchesQuery('', 'dawson')).toBe(false);
        expect(selfMatchesQuery('   ', 'dawson')).toBe(false);
    });
    it('matches your name as a substring, case-insensitively', () => {
        expect(selfMatchesQuery('daw', 'Dawson')).toBe(true);
        expect(selfMatchesQuery('SON', 'dawson')).toBe(true);
    });
    it('matches the words people type for it', () => {
        expect(selfMatchesQuery('me', 'dawson')).toBe(true);
        expect(selfMatchesQuery('myself', 'dawson')).toBe(true);
    });
    it('NEGATIVE: someone else\'s name does not match', () => {
        expect(selfMatchesQuery('sam', 'dawson')).toBe(false);
        expect(selfMatchesQuery('x', '')).toBe(false);
    });
});

describe('buildDmPickerResults (the new-message picker)', () => {
    const me = { user_id: ME, username: 'dawson', avatar_url: 'av1' };
    const friends = [
        { user_id: FRIEND, username: 'sam' },
        { user_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', username: 'dawn' },
    ];

    it('with no search text the list is just your friends — you are NOT in it', () => {
        const out = buildDmPickerResults({ search: '', me, friends });
        expect(out.map(r => r.username)).toEqual(['sam', 'dawn']);
        expect(out.some(r => r.isSelf)).toBe(false);
    });
    it('searching your name puts you first, labelled as self, ahead of matching friends', () => {
        const out = buildDmPickerResults({ search: 'daw', me, friends });
        expect(out.map(r => r.username)).toEqual(['dawson', 'dawn']);
        expect(out[0]).toMatchObject({ user_id: ME, isSelf: true, avatar_url: 'av1' });
        expect(out[1].isSelf).toBeUndefined();
    });
    it('"me" finds you even though no friend matches', () => {
        const out = buildDmPickerResults({ search: 'me', me, friends: [] });
        expect(out).toHaveLength(1);
        expect(out[0].isSelf).toBe(true);
    });
    it('a search for someone else does not list you', () => {
        expect(buildDmPickerResults({ search: 'sam', me, friends }).map(r => r.username)).toEqual(['sam']);
    });
    it('never lists you twice, whatever the friends payload holds', () => {
        const dirty = [...friends, { user_id: ME, username: 'dawson' }];
        expect(buildDmPickerResults({ search: 'daw', me, friends: dirty }).filter(r => r.user_id === ME)).toHaveLength(1);
        expect(buildDmPickerResults({ search: '', me, friends: dirty }).some(r => r.user_id === ME)).toBe(false);
    });
    it('signed-out (no me) just filters friends', () => {
        expect(buildDmPickerResults({ search: 'me', me: null, friends }).length).toBe(0);
    });
});

describe('chatAffordances — what a self chat does not do', () => {
    it('a self chat turns off typing, receipts, calls, trust badge, friend actions, notification mode and the friendship lookup', () => {
        expect(chatAffordances(true)).toEqual({
            typingIndicators: false,
            readReceipts: false,
            calls: false,
            trustBadge: false,
            friendActions: false,
            notificationMode: false,
            friendshipLookup: false,
        });
    });
    it('NEGATIVE CONTROL: an ordinary chat keeps every one of them', () => {
        expect(Object.values(chatAffordances(false)).every(v => v === true)).toBe(true);
    });
});

describe('isSilentIncoming — your own notes never buzz', () => {
    it('everything in the self conversation is silent, even with a missing/foreign sender field', () => {
        expect(isSilentIncoming({ senderUserId: undefined, myUserId: ME, convIsSelf: true })).toBe(true);
        expect(isSilentIncoming({ senderUserId: FRIEND, myUserId: ME, convIsSelf: true })).toBe(true);
    });
    it('anything you sent yourself is silent anywhere (self-fan-out to your other devices)', () => {
        expect(isSilentIncoming({ senderUserId: ME, myUserId: ME, convIsSelf: false })).toBe(true);
    });
    it('NEGATIVE CONTROL: another person\'s message in an ordinary chat still notifies', () => {
        expect(isSilentIncoming({ senderUserId: FRIEND, myUserId: ME, convIsSelf: false })).toBe(false);
        expect(isSilentIncoming({ senderUserId: undefined, myUserId: ME, convIsSelf: false })).toBe(false);
        expect(isSilentIncoming({ senderUserId: undefined, myUserId: null, convIsSelf: false })).toBe(false);
    });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
// The rules above are only worth anything if the components actually route
// through them. Dashboard/ChatPane are too large to mount in a unit test, so
// this pins the wiring over the source text (same technique as
// apps/api's send-gate-scope.spec.ts), each with a positive control.

const SRC = path.join(__dirname, '..', 'components');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('wiring (source-level)', () => {
    const chat = read('ChatPane.tsx');
    const dash = read('Dashboard.tsx');
    const picker = read('StartDMModal.tsx');

    it('ChatPane: calls, typing, read receipts and the friendship lookup are gated by the self affordances', () => {
        expect(chat).toMatch(/!activeChannel && affordances\.calls/);
        expect(chat).toMatch(/affordances\.typingIndicators \? sendTypingEventProp : NOOP_TYPING/);
        expect(chat).toMatch(/showReadReceipts: showReadReceipts && affordances\.readReceipts/);
        expect(chat).toMatch(/if \(!affordances\.friendshipLookup\)/);
        // a self chat's "..." menu has no block / report / friend entries
        expect(chat).toMatch(/else if \(isSelfChat\)/);
    });

    it('Dashboard: the incoming-message loop asks isSilentIncoming (no unread, toast or sound for self)', () => {
        expect(dash).toMatch(/!isSilentIncoming\(\{ senderUserId: m\.sender_user_id, myUserId: userId, convIsSelf \}\)/);
    });

    it('Dashboard: every place that replaces the conversation list from the server labels the self row', () => {
        const labelled = dash.match(/setConversations\(labelSelfConversations\(/g) ?? [];
        expect(labelled.length).toBe(4);
        // positive control: the raw, unlabelled form really exists elsewhere only for local patches (functional updates)
        expect(dash).toMatch(/setConversations\(prev =>/);
        expect(dash).not.toMatch(/setConversations\((?:res|convsRes)\.data\)/);
    });

    it('Dashboard: the DM list search offers you only while no self chat exists, and never otherwise', () => {
        expect(dash).toMatch(/selfMatchesQuery\(listSearch, user\?\.username\)\s*\n\s*&& !conversations\.some\(c => isSelfDm\(c, authUserId\)\)/);
    });

    it('Dashboard: no Block entry for your own chat (list menu and details panel)', () => {
        expect(dash).toMatch(/isDm && conv\.other_user_id && !conv\.is_self \? \[\{\s*\n\s*icon: <UserX \/>/);
        expect(dash).toMatch(/isSelfDm\(activeChat, authUserId\) \? null : \(/);
    });

    it('StartDMModal: results come from buildDmPickerResults', () => {
        expect(picker).toMatch(/buildDmPickerResults\(\{ search, me: user, friends \}\)/);
    });
});
