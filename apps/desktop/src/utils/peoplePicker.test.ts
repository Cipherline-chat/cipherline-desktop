/**
 * People picker rules (utils/peoplePicker.ts) — sections/order, status line,
 * relative time, highlight movement, the keyboard decision table, and the
 * footer's primary action.
 */
import { describe, it, expect } from 'vitest';
import {
    toPickerPeople, buildPickerSections, flattenSections, moveHighlight, pickerKeyIntent, primaryActionFor,
    toggleSelection, personSecondary, formatShortAgo, matchRank, RECENT_LIMIT, type PickerPerson,
} from './peoplePicker';

const NOW = 1_800_000_000_000;
const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;

const friends = [
    { user_id: 'a', username: 'anna' },
    { user_id: 'b', username: 'Bea' },
    { user_id: 'c', username: 'carl' },
    { user_id: 'd', username: 'Dmitri' },
    { user_id: 'e', username: 'eve.online' },
    { user_id: 'f', username: 'Fay', status: 'online' }, // payload-only status
];
const conversations = [
    { conversation_id: 'c-b', type: 'dm', other_user_id: 'b' },
    { conversation_id: 'c-d', type: 'dm', other_user_id: 'd' },
    { conversation_id: 'c-c', type: 'dm', other_user_id: 'c' }, // chat, but no known activity
    { conversation_id: 'g', type: 'group' },
];
const statuses = {
    a: { status: 'online', custom_status_text: 'heads down', custom_status_emoji: '🎧' },
    b: { status: 'offline', custom_status_text: 'leaked?', current_game: 'Chess' },
    d: { status: 'away', current_game: 'Valorant' },
    e: { status: 'dnd', on_mobile: true },
};
const last = { 'c-b': NOW - 2 * HR, 'c-d': NOW - 5 * MIN };
const people = () => toPickerPeople({ rows: friends, conversations, statuses, presence: {}, lastActivityAt: last, myUserId: 'me' });
const byId = (ps: PickerPerson[], id: string) => ps.find(p => p.user_id === id)!;

describe('toPickerPeople', () => {
    it('attaches chat + activity facts from existing DMs only (groups ignored)', () => {
        const ps = people();
        expect(byId(ps, 'b')).toMatchObject({ hasChat: true, conversationId: 'c-b', lastActivityAt: NOW - 2 * HR });
        expect(byId(ps, 'c')).toMatchObject({ hasChat: true, lastActivityAt: null });
        expect(byId(ps, 'a')).toMatchObject({ hasChat: false, conversationId: null });
    });
    it('live map wins; payload status is only the fallback; presence promotes to online', () => {
        const ps = toPickerPeople({ rows: friends, conversations, statuses, presence: { c: true }, lastActivityAt: last });
        expect(byId(ps, 'f').status).toBe('online');   // payload fallback
        expect(byId(ps, 'c').status).toBe('online');   // presence promotion
        expect(byId(ps, 'b').status).toBe('offline');
        // control: no live info and no payload status → offline
        expect(byId(ps, 'a').status).toBe('online');
        expect(toPickerPeople({ rows: [{ user_id: 'x', username: 'x' }], conversations: [] })[0].status).toBe('offline');
    });
    it('recognises your self chat for the self row', () => {
        const ps = toPickerPeople({
            rows: [{ user_id: 'me', username: 'Dawson', isSelf: true }],
            conversations: [{ conversation_id: 'self', type: 'dm', other_user_id: 'me', is_self: true }],
            myUserId: 'me',
        });
        expect(ps[0]).toMatchObject({ hasChat: true, conversationId: 'self', secondary: 'Message yourself' });
    });
});

describe('personSecondary', () => {
    it('offline never shows a custom status or game (no leak through the picker)', () => {
        const b = byId(people(), 'b');
        expect(b.secondary).toBe('Offline');
        expect(b.currentGame).toBeNull();
    });
    it('custom status > game > mobile > plain label', () => {
        expect(byId(people(), 'a').secondary).toBe('🎧 heads down');
        expect(byId(people(), 'd').secondary).toBe('Playing Valorant');
        expect(byId(people(), 'e').secondary).toBe('Do Not Disturb on mobile');
        expect(personSecondary({ status: 'online' })).toBe('Online');
        expect(personSecondary({ status: 'away' })).toBe('Away');
    });
});

describe('buildPickerSections (no search)', () => {
    it('Recent (newest first) → Online → Offline, everyone exactly once', () => {
        const s = buildPickerSections(people(), '');
        expect(s.map(x => x.key)).toEqual(['recent', 'online', 'offline']);
        expect(s[0].people.map(p => p.user_id)).toEqual(['d', 'b']);
        expect(s[1].people.map(p => p.username)).toEqual(['anna', 'eve.online', 'Fay']); // A–Z, case-insensitive
        expect(s[2].people.map(p => p.user_id)).toEqual(['c']);
        const all = flattenSections(s).map(p => p.user_id);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(friends.length);
    });
    it('Recent is capped; the overflow falls back into Online/Offline', () => {
        const many = Array.from({ length: RECENT_LIMIT + 2 }, (_, i) => ({ user_id: 'u' + i, username: 'u' + i }));
        const ps = toPickerPeople({
            rows: many,
            conversations: many.map(m => ({ conversation_id: 'c' + m.user_id, type: 'dm', other_user_id: m.user_id })),
            lastActivityAt: Object.fromEntries(many.map((m, i) => ['c' + m.user_id, NOW - i * MIN])),
        });
        const s = buildPickerSections(ps, '');
        expect(s[0].people).toHaveLength(RECENT_LIMIT);
        expect(s[0].people[0].user_id).toBe('u0');
        expect(flattenSections(s)).toHaveLength(many.length);
    });
    it('empty input → no sections', () => {
        expect(buildPickerSections([], '')).toEqual([]);
        expect(buildPickerSections([], 'x')).toEqual([]);
    });
});

describe('buildPickerSections (search)', () => {
    it('one Results section: exact → prefix → word start → anywhere', () => {
        const rows = [
            { user_id: '1', username: 'steve' },     // anywhere
            { user_id: '2', username: 'eve.online' }, // prefix
            { user_id: '3', username: 'big.eve' },   // word start
            { user_id: '4', username: 'Eve' },       // exact (case-insensitive)
        ];
        const s = buildPickerSections(toPickerPeople({ rows, conversations: [] }), 'eve');
        expect(s.map(x => x.key)).toEqual(['results']);
        expect(s[0].people.map(p => p.user_id)).toEqual(['4', '2', '3', '1']);
    });
    it('ties break by recent chat, then presence, then name; the self row always leads', () => {
        const rows = [
            { user_id: 'o', username: 'mo' },
            { user_id: 'p', username: 'mp', status: 'online' },
            { user_id: 'r', username: 'mr' },
            { user_id: 'me', username: 'm-self', isSelf: true },
        ];
        const ps = toPickerPeople({ rows, conversations: [{ conversation_id: 'cr', type: 'dm', other_user_id: 'r' }], lastActivityAt: { cr: NOW } });
        expect(buildPickerSections(ps, 'm')[0].people.map(p => p.user_id)).toEqual(['me', 'r', 'p', 'o']);
    });
    it('matchRank', () => {
        expect(matchRank('Eve', 'eve')).toBe(0);
        expect(matchRank('evelyn', 'eve')).toBe(1);
        expect(matchRank('big_eve', 'eve')).toBe(2);
        expect(matchRank('steve', 'eve')).toBe(3);
        expect(matchRank('bob', 'eve')).toBe(-1);
    });
});

describe('formatShortAgo', () => {
    it.each([
        [NOW - 20_000, 'now'], [NOW - 4 * MIN, '4m'], [NOW - 59 * MIN, '59m'], [NOW - 60 * MIN, '1h'],
        [NOW - 23 * HR, '23h'], [NOW - DAY, '1d'], [NOW - 6 * DAY, '6d'], [NOW - 7 * DAY, '1w'],
        [NOW - 29 * DAY, '4w'], [NOW - 30 * DAY, '1mo'], [NOW - 200 * DAY, '6mo'], [NOW - 400 * DAY, '1y'],
    ])('%s → %s', (t, out) => { expect(formatShortAgo(t, NOW)).toBe(out); });
    it('null / future → null', () => {
        expect(formatShortAgo(null, NOW)).toBeNull();
        expect(formatShortAgo(NOW + 5000, NOW)).toBeNull();
    });
});

describe('moveHighlight', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    it('single steps wrap, page jumps clamp', () => {
        expect(moveHighlight(ids, 'a', 1)).toBe('b');
        expect(moveHighlight(ids, 'g', 1)).toBe('a');
        expect(moveHighlight(ids, 'a', -1)).toBe('g');
        expect(moveHighlight(ids, 'a', 5)).toBe('f');
        expect(moveHighlight(ids, 'e', 5)).toBe('g');
        expect(moveHighlight(ids, 'c', -5)).toBe('a');
    });
    it('no/unknown current → first going down, last going up; empty → null', () => {
        expect(moveHighlight(ids, null, 1)).toBe('a');
        expect(moveHighlight(ids, 'zz', -1)).toBe('g');
        expect(moveHighlight([], 'a', 1)).toBeNull();
    });
});

describe('pickerKeyIntent — the keyboard decision table', () => {
    const ctx = (query = '', selectionCount = 0, multiSelect = true) => ({ query, selectionCount, multiSelect });
    it('navigation', () => {
        expect(pickerKeyIntent({ key: 'ArrowDown' }, ctx())).toEqual({ type: 'move', delta: 1 });
        expect(pickerKeyIntent({ key: 'ArrowUp' }, ctx('x'))).toEqual({ type: 'move', delta: -1 });
        expect(pickerKeyIntent({ key: 'PageDown' }, ctx())).toEqual({ type: 'move', delta: 5 });
        expect(pickerKeyIntent({ key: 'Home' }, ctx())).toEqual({ type: 'first' });
        expect(pickerKeyIntent({ key: 'End' }, ctx())).toEqual({ type: 'last' });
        // Home/End belong to the caret while there is text
        expect(pickerKeyIntent({ key: 'Home' }, ctx('ab'))).toBeNull();
        expect(pickerKeyIntent({ key: 'End' }, ctx('ab'))).toBeNull();
    });
    it('Enter: open when nothing is selected, primary when something is', () => {
        expect(pickerKeyIntent({ key: 'Enter' }, ctx('', 0))).toEqual({ type: 'open' });
        expect(pickerKeyIntent({ key: 'Enter' }, ctx('abc', 0))).toEqual({ type: 'open' });
        expect(pickerKeyIntent({ key: 'Enter' }, ctx('', 2))).toEqual({ type: 'primary' });
        expect(pickerKeyIntent({ key: 'Enter', ctrlKey: true }, ctx('', 1))).toEqual({ type: 'primary' });
    });
    it('Shift+Enter toggles (clearing a query); Space toggles only on an empty query', () => {
        expect(pickerKeyIntent({ key: 'Enter', shiftKey: true }, ctx('an'))).toEqual({ type: 'toggle', clearQuery: true });
        expect(pickerKeyIntent({ key: 'Enter', shiftKey: true }, ctx(''))).toEqual({ type: 'toggle', clearQuery: false });
        expect(pickerKeyIntent({ key: ' ' }, ctx(''))).toEqual({ type: 'toggle', clearQuery: false });
        expect(pickerKeyIntent({ key: ' ' }, ctx('an'))).toBeNull(); // types a space
    });
    it('single-select pickers never toggle', () => {
        expect(pickerKeyIntent({ key: 'Enter', shiftKey: true }, ctx('an', 0, false))).toEqual({ type: 'open' });
        expect(pickerKeyIntent({ key: ' ' }, ctx('', 0, false))).toBeNull();
    });
    it('Backspace removes the last chip only on an empty query with a selection', () => {
        expect(pickerKeyIntent({ key: 'Backspace' }, ctx('', 2))).toEqual({ type: 'removeLast' });
        expect(pickerKeyIntent({ key: 'Backspace' }, ctx('a', 2))).toBeNull();
        expect(pickerKeyIntent({ key: 'Backspace' }, ctx('', 0))).toBeNull();
    });
    it('IME composition, Alt chords and Escape are left alone (ClModal owns Escape)', () => {
        expect(pickerKeyIntent({ key: 'Enter', isComposing: true }, ctx())).toBeNull();
        expect(pickerKeyIntent({ key: 'ArrowDown', altKey: true }, ctx())).toBeNull();
        expect(pickerKeyIntent({ key: 'Escape' }, ctx())).toBeNull();
        expect(pickerKeyIntent({ key: 'a' }, ctx())).toBeNull();
    });
});

describe('primaryActionFor + toggleSelection', () => {
    const ps = people();
    it('0 → disabled "Start chat"; 1 → open/start by whether a chat exists; 2+ → group', () => {
        expect(primaryActionFor([])).toEqual({ kind: 'none', label: 'Start chat' });
        expect(primaryActionFor([byId(ps, 'b')])).toMatchObject({ kind: 'open', label: 'Open chat' });
        expect(primaryActionFor([byId(ps, 'a')])).toMatchObject({ kind: 'open', label: 'Start chat' });
        const g = primaryActionFor([byId(ps, 'a'), byId(ps, 'b')]);
        expect(g).toMatchObject({ kind: 'group', label: 'Start group chat' });
        expect(g.kind === 'group' && g.people.map(p => p.user_id)).toEqual(['a', 'b']);
    });
    it('toggleSelection keeps order, removes, and stops at the cap', () => {
        expect(toggleSelection([], 'a', 3)).toEqual(['a']);
        expect(toggleSelection(['a', 'b'], 'a', 3)).toEqual(['b']);
        const full = ['a', 'b', 'c'];
        expect(toggleSelection(full, 'd', 3)).toBe(full);
        expect(toggleSelection(full, 'b', 3)).toEqual(['a', 'c']); // removing at the cap still works
    });
});
