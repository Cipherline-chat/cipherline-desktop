import { describe, it, expect } from 'vitest';
import { FORMER_MEMBER_NAME } from '@cipherline/shared';
import {
    MEMBER_EVENT_KIND, isRawSystemRow, memberEventFromHistory, memberEventFromLive, isMemberEventContent,
    memberEventText, memberEventUserIds, addMemberEventRow, memberEventIsMine, decideChannelSystemRow,
    memberEventFromLegacy, addEphemeralMemberEventRow, dropShadowedEphemeralRows, isEphemeralMemberEventId,
    EPHEMERAL_MEMBER_EVENT_PREFIX,
    type MemberEventContent,
} from './systemMessages';
import { foldChannelHistory, isUndecryptablePlaceholder, type ChannelRow } from './channelHistoryMerge';
import { decideChannelMessage } from './notificationDecision';
import { needsKeyWaitState, summarizeNewestPage } from './channelKeyWait';
import { channelPlaceholderContent, placeholderReason } from './channelDecryptFailure';
import { splitReusableChannelRows } from './channelRowReuse';

const CH = 'chan-system';
const ME = 'u-1111';
const NEWBIE = 'u-3333';
const MOD = 'u-2222';

const rawJoin = (over: Record<string, unknown> = {}) => ({
    id: 'row-join', kind: 'system' as const, system_event: 'member_join',
    system_subject_user_id: NEWBIE, system_actor_user_id: null, created_at: '2026-10-13T10:00:00.000Z', ...over,
});

const names: Record<string, string> = { [NEWBIE]: 'newbie', [MOD]: 'mod', [ME]: 'me' };
const nameOf = (id: string) => names[id];

describe('history row -> local member-event row', () => {
    it('a join row in history renders "<current username> joined the server."', () => {
        const row = memberEventFromHistory(CH, rawJoin())!;
        expect(row).toMatchObject({
            id: 'row-join', conversation_id: CH, timestamp: '2026-10-13T10:00:00.000Z',
            sender_user_id: null, sender_device_id: '',
        });
        expect(isMemberEventContent(row.content)).toBe(true);
        expect(memberEventText(row.content, nameOf)).toBe('newbie joined the server.');
    });

    it('the name is the CURRENT one: a rename shows through, nothing was frozen into the row', () => {
        const row = memberEventFromHistory(CH, rawJoin())!;
        expect(JSON.stringify(row)).not.toContain('newbie');
        expect(memberEventText(row.content, id => (id === NEWBIE ? 'newbie_renamed' : undefined))).toBe('newbie_renamed joined the server.');
    });

    it('an unknown or deleted user reads "A former member" - never a raw id', () => {
        const unknownId = memberEventFromHistory(CH, rawJoin())!;
        expect(memberEventText(unknownId.content, () => undefined)).toBe(`${FORMER_MEMBER_NAME} joined the server.`);
        const erased = memberEventFromHistory(CH, rawJoin({ system_subject_user_id: null }))!;
        expect(memberEventText(erased.content, nameOf)).toBe('A former member joined the server.');
        expect(memberEventText(erased.content, nameOf)).not.toContain(NEWBIE);
    });

    it.each([
        ['member_leave', 'newbie left the server.'],
        ['member_kick', 'newbie was kicked by mod.'],
        ['member_ban', 'newbie was banned by mod.'],
    ])('%s -> %s', (ev, text) => {
        const row = memberEventFromHistory(CH, rawJoin({ system_event: ev, system_actor_user_id: MOD }))!;
        expect(memberEventText(row.content, nameOf)).toBe(text);
    });

    it('a kick whose moderator is unknown/erased still reads naturally', () => {
        const row = memberEventFromHistory(CH, rawJoin({ system_event: 'member_kick', system_actor_user_id: null }))!;
        expect(memberEventText(row.content, nameOf)).toBe('newbie was kicked by a moderator.');
    });

    it('names the roster must resolve are listed (subject and moderator, no blanks)', () => {
        const row = memberEventFromHistory(CH, rawJoin({ system_event: 'member_ban', system_actor_user_id: MOD }))!;
        expect(memberEventUserIds(row.content)).toEqual([NEWBIE, MOD]);
        expect(memberEventUserIds(memberEventFromHistory(CH, rawJoin({ system_subject_user_id: null }))!.content)).toEqual([]);
    });

    it('malformed rows are dropped, never coerced (negative controls)', () => {
        expect(memberEventFromHistory(CH, rawJoin({ system_event: 'member_teleport' }))).toBeNull();
        expect(memberEventFromHistory(CH, rawJoin({ system_event: undefined }))).toBeNull();
        expect(memberEventFromHistory(CH, rawJoin({ id: '' }))).toBeNull();
        expect(memberEventFromHistory(CH, rawJoin({ created_at: 'yesterday-ish' }))).toBeNull();
        expect(memberEventFromHistory(CH, rawJoin({ system_subject_user_id: 42 }))!.content.subject_user_id).toBeNull();
    });

    it('isRawSystemRow keys on the server\'s kind only', () => {
        expect(isRawSystemRow({ kind: 'system' })).toBe(true);
        expect(isRawSystemRow({ kind: 'message' })).toBe(false);
        expect(isRawSystemRow({})).toBe(false); // an API that predates the field
        expect(isRawSystemRow(null)).toBe(false);
    });
});

describe('live event -> the SAME row as history', () => {
    const live = {
        channel_id: CH, server_id: 'srv', message_id: 'row-join', kind: 'system' as const, system_event: 'member_join' as const,
        system_subject_user_id: NEWBIE, system_actor_user_id: null, created_at: '2026-10-13T10:00:00.000Z',
    };

    it('is identical to the history row (so the two de-duplicate by id)', () => {
        expect(memberEventFromLive(live)).toEqual(memberEventFromHistory(CH, rawJoin()));
    });

    it('rejects a payload that is not a well-formed system event', () => {
        expect(memberEventFromLive(null)).toBeNull();
        expect(memberEventFromLive({ ...live, kind: 'message' as never })).toBeNull();
        expect(memberEventFromLive({ ...live, system_event: 'x' as never })).toBeNull();
        expect(memberEventFromLive({ ...live, channel_id: undefined })).toBeNull();
        expect(memberEventFromLive({ ...live, message_id: undefined })).toBeNull();
    });
});

describe('merging into a thread: no duplicate, no overwrite', () => {
    const joinRow = memberEventFromLive({ channel_id: CH, server_id: 's', message_id: 'a', kind: 'system', system_event: 'member_join', system_subject_user_id: NEWBIE, system_actor_user_id: null, created_at: '2026-10-13T10:00:00.000Z' })!;
    const leaveRow = memberEventFromLive({ channel_id: CH, server_id: 's', message_id: 'b', kind: 'system', system_event: 'member_leave', system_subject_user_id: MOD, system_actor_user_id: null, created_at: '2026-10-13T10:00:01.000Z' })!;

    it('live THEN history delivers the same row: still one', () => {
        const afterLive = addMemberEventRow([], joinRow);
        expect(afterLive).toHaveLength(1);
        // history path: the fold ignores an id it already holds
        const afterHistory = foldChannelHistory(afterLive as ChannelRow[], [memberEventFromHistory(CH, rawJoin({ id: 'a' }))! as ChannelRow]);
        expect(afterHistory.filter(r => r.id === 'a')).toHaveLength(1);
    });

    it('history THEN live delivers the same row: the thread is returned untouched (same array, no re-render)', () => {
        const thread = [memberEventFromHistory(CH, rawJoin({ id: 'a' }))!];
        expect(addMemberEventRow(thread, joinRow)).toBe(thread);
    });

    it('two events a moment apart BOTH survive (the old single slot overwrote the first)', () => {
        let thread: readonly unknown[] = [];
        thread = addMemberEventRow(thread as never[], joinRow);
        thread = addMemberEventRow(thread as never[], leaveRow);
        expect((thread as Array<{ id: string }>).map(r => r.id)).toEqual(['a', 'b']);
    });

    it('stays chronological when a late row arrives', () => {
        const t = addMemberEventRow([leaveRow], joinRow);
        expect(t.map(r => r.id)).toEqual(['a', 'b']);
    });
});

describe('history fold keeps system rows in order with real messages', () => {
    const msg = (id: string, ts: string): ChannelRow => ({ id, timestamp: ts, sender_user_id: 'u', content: { type: 'text', text: id } });

    it('a page of messages and system rows folds into one chronological thread', () => {
        const sys1 = memberEventFromHistory(CH, rawJoin({ id: 's1', created_at: '2026-10-13T10:00:30.000Z' }))! as ChannelRow;
        const folded = foldChannelHistory([], [msg('m2', '2026-10-13T10:01:00.000Z'), sys1, msg('m1', '2026-10-13T10:00:00.000Z')]);
        expect(folded.map(r => r.id)).toEqual(['m1', 's1', 'm2']);
    });

    it('a re-fetch of the same page does not duplicate the system row', () => {
        const sys1 = memberEventFromHistory(CH, rawJoin({ id: 's1' }))! as ChannelRow;
        const once = foldChannelHistory([], [sys1]);
        const twice = foldChannelHistory(once, [memberEventFromHistory(CH, rawJoin({ id: 's1' }))! as ChannelRow]);
        expect(twice).toHaveLength(1);
    });

    it('REACTIONS on a system row work: the reaction lands on the row by id (a wave at the new member)', () => {
        const sys1 = memberEventFromHistory(CH, rawJoin({ id: 's1' }))! as ChannelRow;
        const wave: ChannelRow = { id: 'r1', timestamp: '2026-10-13T10:00:05.000Z', sender_user_id: ME, content: { type: 'reaction', target_id: 's1', emoji: '👋', action: 'add' } };
        const folded = foldChannelHistory([sys1], [wave]);
        expect(folded).toHaveLength(1); // the reaction envelope itself is not a row
        expect(folded[0].reactions).toEqual({ '👋': [ME] });
        // ...and removing it clears the chip
        const unwave: ChannelRow = { id: 'r2', timestamp: '2026-10-13T10:00:06.000Z', sender_user_id: ME, content: { type: 'reaction', target_id: 's1', emoji: '👋', action: 'remove' } };
        expect(foldChannelHistory(folded, [unwave])[0].reactions).toEqual({});
    });

    it('a moderator\'s delete marker removes the system row once the server confirms it (F3)', () => {
        const sys1 = memberEventFromHistory(CH, rawJoin({ id: 's1' }))! as ChannelRow;
        const del: ChannelRow = { id: 'd1', timestamp: '2026-10-13T10:00:07.000Z', sender_user_id: MOD, content: { type: 'delete', target_id: 's1' } };
        // Confirmed (Dashboard checks the server no longer has the row).
        expect(foldChannelHistory([sys1], [del], new Set(), undefined, { moderatorDeleteTargets: new Set(['s1']) })).toHaveLength(0);
        // Unconfirmed: a delete marker alone cannot remove it.
        expect(foldChannelHistory([sys1], [del])).toHaveLength(1);
    });

    it('a cached system row is reused, never re-processed or mistaken for a placeholder', () => {
        const cached = memberEventFromHistory(CH, rawJoin({ id: 's1' }))!;
        expect(isUndecryptablePlaceholder(cached)).toBe(false);
        expect(placeholderReason(cached)).toBeNull();
        const { reused, toDecrypt } = splitReusableChannelRows([{ id: 's1' }, { id: 'm1' }], [cached]);
        expect(reused).toEqual([cached]);
        expect(toDecrypt).toEqual([{ id: 'm1' }]);
    });
});

describe('key-wait stays neutral about system rows', () => {
    const sys = (id: string) => memberEventFromHistory(CH, rawJoin({ id }))!;
    const missing = (id: string) => ({ id, content: channelPlaceholderContent('key_missing', 3), sender_device_id: 'd' });

    it('system rows are neither readable nor unreadable', () => {
        expect(summarizeNewestPage([sys('a'), sys('b')])).toEqual({ readable: 0, keyMissing: 0, keyMismatch: 0, otherUndecryptable: 0 });
    });

    it('a joiner\'s page - their own join line plus messages they cannot read yet - is still "waiting on keys"', () => {
        // The join line is the NEWEST row of a brand-new member's channel; if it
        // counted as readable it would suppress the whole-pane key wait.
        const page = [missing('m1'), missing('m2'), missing('m3'), sys('join')];
        expect(needsKeyWaitState(page)).toBe(true);
    });

    it('control: a REAL readable message in the same page does end the wait', () => {
        const page = [missing('m1'), { id: 'ok', content: { type: 'text', text: 'hi' }, sender_device_id: 'd' }, sys('join')];
        expect(needsKeyWaitState(page)).toBe(false);
    });
});

describe('unread / notification decision for a system row', () => {
    const joinContent = memberEventFromHistory(CH, rawJoin())!.content;
    const kickContent = memberEventFromHistory(CH, rawJoin({ system_event: 'member_kick', system_actor_user_id: MOD }))!.content;
    const away = { windowFocused: false, isActiveConversation: false };

    it('level "all": counts as unread - and is NEVER a mention, never a sound, never an OS toast', () => {
        const d = decideChannelSystemRow({ content: joinContent, userId: ME, mode: 'all', ...away })!;
        expect(d).toEqual({ isMention: false, countsMention: false, countsUnread: true, playsSound: false, showsToast: false });
    });

    it('level "@mentions only": still counts (quietly), exactly like a plain message does', () => {
        const sys = decideChannelSystemRow({ content: joinContent, userId: ME, mode: 'mentions', ...away })!;
        const plain = decideChannelMessage({
            content: { type: 'text', text: 'hello' }, senderUserId: 'someone', userId: ME, mentionsEveryone: false, myRoleIds: new Set(),
            keywords: [], mode: 'mentions', ...away, suppressWhenActiveConv: false, dndActive: false, dndLetMentionsThrough: false,
        })!;
        expect(sys.countsUnread).toBe(plain.countsUnread);
        expect(sys.countsUnread).toBe(true);
        expect(sys.countsMention).toBe(false);
    });

    it('level "nothing": no unread at all - same as a plain message', () => {
        expect(decideChannelSystemRow({ content: joinContent, userId: ME, mode: 'none', ...away })!.countsUnread).toBe(false);
    });

    it('looking right at the channel: nothing to count', () => {
        const d = decideChannelSystemRow({ content: joinContent, userId: ME, mode: 'all', windowFocused: true, isActiveConversation: true })!;
        expect(d.countsUnread).toBe(false);
    });

    it('a blurred window on the open channel still counts (you are not watching)', () => {
        const d = decideChannelSystemRow({ content: joinContent, userId: ME, mode: 'all', windowFocused: false, isActiveConversation: true })!;
        expect(d.countsUnread).toBe(true);
    });

    it('your own join, or a kick/ban you carried out, is not news to you', () => {
        const mineJoin = memberEventFromHistory(CH, rawJoin({ system_subject_user_id: ME }))!.content;
        expect(memberEventIsMine(mineJoin, ME)).toBe(true);
        expect(decideChannelSystemRow({ content: mineJoin, userId: ME, mode: 'all', ...away })).toBeNull();
        expect(decideChannelSystemRow({ content: kickContent, userId: MOD, mode: 'all', ...away })).toBeNull();
        // control: somebody else's kick is news
        expect(decideChannelSystemRow({ content: kickContent, userId: ME, mode: 'all', ...away })!.countsUnread).toBe(true);
    });

    it('a username that looks like a ping cannot become a mention (the row has no text to match)', () => {
        const c: MemberEventContent = { type: 'system', kind: MEMBER_EVENT_KIND, event: 'member_join', subject_user_id: NEWBIE, actor_user_id: null };
        const d = decideChannelSystemRow({ content: c, userId: ME, mode: 'all', ...away })!;
        expect(d.countsMention).toBe(false);
        // and the history reconcile scan (decideChannelMessage) skips it: no sender
        expect(decideChannelMessage({
            content: c as never, senderUserId: null, userId: ME, mentionsEveryone: true, myRoleIds: new Set(),
            keywords: ['newbie'], mode: 'all', ...away, suppressWhenActiveConv: false, dndActive: false, dndLetMentionsThrough: false,
        })).toBeNull();
    });

    it('negative control: a plain message in the same state DOES play a sound (the suppression is specific to system rows)', () => {
        const plain = decideChannelMessage({
            content: { type: 'text', text: 'hello' }, senderUserId: 'someone', userId: ME, mentionsEveryone: false, myRoleIds: new Set(),
            keywords: [], mode: 'all', ...away, suppressWhenActiveConv: false, dndActive: false, dndLetMentionsThrough: false,
        })!;
        expect(plain.playsSound).toBe(true);
        expect(plain.showsToast).toBe(true);
    });
});

// ── The ephemeral fallback (API SYSTEM_MESSAGE_ROWS_ENABLED unset) ───────────
// While the API's write flag is off there are NO persisted rows; the legacy
// `channel:system_event` is the only signal and must still draw a join line.

const legacy = (over: Record<string, unknown> = {}) => ({
    server_id: 's1', channel_id: CH, event_type: 'member_join', user_id: NEWBIE,
    username: 'stale-pushed-name', created_at: '2026-10-13T10:00:00.000Z', ...over,
});

describe('ephemeral fallback from the legacy channel:system_event', () => {
    it('renders a join line from ids + the CURRENT username (the pushed name is ignored and never stored)', () => {
        const row = memberEventFromLegacy(legacy())!;
        expect(row).not.toBeNull();
        expect(isEphemeralMemberEventId(row.id)).toBe(true);
        expect(row.id.startsWith(EPHEMERAL_MEMBER_EVENT_PREFIX)).toBe(true);
        expect(row.conversation_id).toBe(CH);
        expect(isMemberEventContent(row.content)).toBe(true);
        expect(JSON.stringify(row)).not.toContain('stale-pushed-name');
        expect(memberEventText(row.content, nameOf)).toBe('newbie joined the server.');
        // a rename shows through; an unknown user is "A former member", never a raw id
        expect(memberEventText(row.content, () => undefined)).toBe(`${FORMER_MEMBER_NAME} joined the server.`);
    });

    it('kick / ban carry the actor id', () => {
        const row = memberEventFromLegacy(legacy({ event_type: 'member_kick', actor_id: MOD }))!;
        expect(row.content.actor_user_id).toBe(MOD);
        expect(memberEventText(row.content, nameOf)).toBe('newbie was kicked by mod.');
    });

    it('malformed / unknown payloads are dropped, never coerced', () => {
        expect(memberEventFromLegacy(null)).toBeNull();
        expect(memberEventFromLegacy(legacy({ event_type: 'member_explode' }))).toBeNull();
        expect(memberEventFromLegacy(legacy({ user_id: undefined }))).toBeNull();
        expect(memberEventFromLegacy(legacy({ channel_id: '' }))).toBeNull();
        expect(memberEventFromLegacy(legacy({ created_at: 'not a date' }))).toBeNull();
    });

    it('the same push twice is ONE row (deduped by id)', () => {
        const row = memberEventFromLegacy(legacy())!;
        const once = addEphemeralMemberEventRow([], row);
        expect(once).toHaveLength(1);
        expect(addEphemeralMemberEventRow(once, memberEventFromLegacy(legacy())!)).toBe(once);
    });

    it('two different events a moment apart both survive (no single slot)', () => {
        let thread: readonly ReturnType<typeof memberEventFromLegacy>[] = [];
        thread = addEphemeralMemberEventRow(thread as never[], memberEventFromLegacy(legacy())!);
        thread = addEphemeralMemberEventRow(thread as never[], memberEventFromLegacy(legacy({ event_type: 'member_leave', created_at: '2026-10-13T10:00:01.000Z' }))!);
        expect(thread).toHaveLength(2);
    });
});

describe('ephemeral line vs a persisted row for the same occurrence (+-5 s)', () => {
    const persisted = (over: Record<string, unknown> = {}) => memberEventFromLive({
        channel_id: CH, server_id: 's1', message_id: 'row-join', kind: 'system', system_event: 'member_join',
        system_subject_user_id: NEWBIE, system_actor_user_id: null, created_at: '2026-10-13T10:00:02.000Z', ...over,
    } as never)!;

    it('persisted row ALREADY there, then the legacy event arrives: the ephemeral line is not added', () => {
        const thread = addMemberEventRow([], persisted());
        expect(addEphemeralMemberEventRow(thread, memberEventFromLegacy(legacy())!)).toBe(thread);
    });

    it('legacy event first, then the persisted row arrives live: exactly one row remains, and it is the persisted one', () => {
        const eph = addEphemeralMemberEventRow([], memberEventFromLegacy(legacy())!);
        expect(eph).toHaveLength(1);
        const after = addMemberEventRow(eph as never[], persisted());
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe('row-join');
    });

    it('legacy line, then the persisted row arrives via a history fold: dropShadowedEphemeralRows leaves one', () => {
        const eph = memberEventFromLegacy(legacy())! as unknown as ChannelRow;
        const hist = persisted() as unknown as ChannelRow;
        const folded = foldChannelHistory([eph], [hist], new Set<string>());
        const out = dropShadowedEphemeralRows(folded);
        expect(out.filter(r => isMemberEventContent(r.content))).toHaveLength(1);
        expect(out.some(r => r.id === 'row-join')).toBe(true);
        expect(out.some(r => isEphemeralMemberEventId(r.id))).toBe(false);
    });

    it('returns the SAME array when nothing is shadowed (no needless re-render)', () => {
        const t = addEphemeralMemberEventRow([], memberEventFromLegacy(legacy())!);
        expect(dropShadowedEphemeralRows(t)).toBe(t);
    });

    it('boundary: 5 s apart is the same occurrence, 6 s apart is not', () => {
        const near = persisted({ created_at: '2026-10-13T10:00:05.000Z' });
        expect(addEphemeralMemberEventRow([near], memberEventFromLegacy(legacy())!)).toHaveLength(1);
        const far = persisted({ created_at: '2026-10-13T10:00:06.000Z' });
        expect(addEphemeralMemberEventRow([far], memberEventFromLegacy(legacy())!)).toHaveLength(2);
    });

    it('a different subject or a different event is NOT a duplicate', () => {
        const other = persisted({ system_subject_user_id: MOD });
        expect(addEphemeralMemberEventRow([other], memberEventFromLegacy(legacy())!)).toHaveLength(2);
        const leave = persisted({ system_event: 'member_leave' });
        expect(addEphemeralMemberEventRow([leave], memberEventFromLegacy(legacy())!)).toHaveLength(2);
    });

    it('two PERSISTED rows are never merged by this rule (a quick rejoin is two real events)', () => {
        let t: readonly unknown[] = addMemberEventRow([], persisted());
        t = addMemberEventRow(t as never[], persisted({ message_id: 'row-join-2', created_at: '2026-10-13T10:00:03.000Z' }));
        expect(t).toHaveLength(2);
    });
});
