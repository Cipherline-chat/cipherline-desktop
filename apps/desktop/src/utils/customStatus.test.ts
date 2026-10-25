import { describe, expect, it } from 'vitest';
import {
    CLEAR_AFTER_OPTIONS, CUSTOM_STATUS_TEXT_MAX, activeCustom, describeExpiry, draftIsEmpty, draftIssue, draftPayload,
    expiresAtFor, initialDraft, nextCustomExpiry, parseStatusEmoji, statusLineModel,
    type CustomStatusDraft,
} from './customStatus';
import { applyPresenceEvent, toEntry } from './presenceState';
import { readSelfEvent, readServerOwnState } from './ownStatusSync';
import type { FriendStatusEntry } from './userStatusModel';

const MIN = 60_000;
// Local time on purpose: "Today" is the viewer's local day.
const NOW = new Date(2026, 9, 23, 15, 0, 0);

describe('Clear after — option mapping', () => {
    it('offers exactly: Dont clear / 30 min / 1 h / 4 h / Today, in that order', () => {
        expect(CLEAR_AFTER_OPTIONS.map(o => o.label)).toEqual(["Don't clear", '30 minutes', '1 hour', '4 hours', 'Today']);
    });
    it('maps each option to an absolute instant (or null for Dont clear)', () => {
        expect(expiresAtFor('never', NOW)).toBeNull();
        expect(Date.parse(expiresAtFor('30m', NOW)!) - NOW.getTime()).toBe(30 * MIN);
        expect(Date.parse(expiresAtFor('1h', NOW)!) - NOW.getTime()).toBe(60 * MIN);
        expect(Date.parse(expiresAtFor('4h', NOW)!) - NOW.getTime()).toBe(240 * MIN);
    });
    it('Today is the end of the LOCAL day, ahead of now and under 24 h', () => {
        const end = new Date(expiresAtFor('today', NOW)!);
        expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2026, 9, 23]);
        expect([end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([23, 59, 59]);
        expect(end.getTime()).toBeGreaterThan(NOW.getTime());
        expect(end.getTime() - NOW.getTime()).toBeLessThan(24 * 60 * MIN);
    });
    it('Today a second before midnight is still in the future', () => {
        const late = new Date(2026, 9, 23, 23, 59, 58);
        expect(Date.parse(expiresAtFor('today', late)!)).toBeGreaterThan(late.getTime());
    });
});

describe('activeCustom — a stored status while it has not expired', () => {
    const t = NOW.getTime();
    it('is shown until the instant, gone at it', () => {
        const at = new Date(t + MIN).toISOString();
        expect(activeCustom('hi', '👋', at, t)).toEqual({ text: 'hi', emoji: '👋', expiresAt: at });
        expect(activeCustom('hi', '👋', at, t + MIN)).toBeNull();
        expect(activeCustom('hi', '👋', at, t + MIN + 1)).toBeNull();
    });
    it('no expiry means it stays; empty text and emoji is nothing', () => {
        expect(activeCustom('hi', null, null, t + 1e12)).toMatchObject({ text: 'hi' });
        expect(activeCustom('', '', null, t)).toBeNull();
        expect(activeCustom(null, null, undefined, t)).toBeNull();
    });
    it('nextCustomExpiry picks the nearest FUTURE expiry only', () => {
        const entries = [
            { custom_status_expires_at: new Date(t - MIN).toISOString() },
            { custom_status_expires_at: new Date(t + 5 * MIN).toISOString() },
            { custom_status_expires_at: new Date(t + 2 * MIN).toISOString() },
            { custom_status_expires_at: null },
            {},
        ];
        expect(nextCustomExpiry(entries, t)).toBe(t + 2 * MIN);
        expect(nextCustomExpiry([{}], t)).toBeNull();
    });
});

describe('the emoji slot', () => {
    it('a unicode emoji is unicode; a cl: reference is a (future) custom emoji; nothing is nothing', () => {
        expect(parseStatusEmoji('🔥')).toEqual({ kind: 'unicode', value: '🔥' });
        expect(parseStatusEmoji('cl:abc123')).toEqual({ kind: 'custom', ref: 'abc123' });
        expect(parseStatusEmoji('cl:')).toEqual({ kind: 'unicode', value: 'cl:' });
        expect(parseStatusEmoji('')).toBeNull();
        expect(parseStatusEmoji(null)).toBeNull();
    });
});

describe('statusLineModel — what shows under a name (game + custom status)', () => {
    const t = NOW.getTime();
    const base = (over: Partial<FriendStatusEntry>): FriendStatusEntry => ({
        status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null, ...over,
    });

    it('custom status AND a game -> the custom status with the controller; tooltip says Playing <game>', () => {
        expect(statusLineModel(base({ custom_status_text: 'grinding', custom_status_emoji: '🔥', current_game: 'Marvel Rivals' }), t))
            .toEqual({ kind: 'custom+game', emoji: '🔥', text: 'grinding', game: 'Marvel Rivals', gameTooltip: 'Playing Marvel Rivals' });
    });
    it('custom status only -> just the custom status, no controller', () => {
        expect(statusLineModel(base({ custom_status_text: 'brb' }), t)).toMatchObject({ kind: 'custom', text: 'brb', game: null, gameTooltip: null });
    });
    it('an emoji alone is a custom status', () => {
        expect(statusLineModel(base({ custom_status_emoji: '🍕', current_game: 'Chess' }), t)).toMatchObject({ kind: 'custom+game', text: null, emoji: '🍕' });
    });
    it('game only -> Playing <game> as before', () => {
        expect(statusLineModel(base({ current_game: 'Chess' }), t)).toMatchObject({ kind: 'game', game: 'Chess', gameTooltip: 'Playing Chess' });
    });
    it('neither -> nothing', () => {
        expect(statusLineModel(base({}), t).kind).toBe('none');
        expect(statusLineModel(undefined, t).kind).toBe('none');
    });
    it('offline shows neither, even if the entry carries them', () => {
        expect(statusLineModel(base({ status: 'offline', custom_status_text: 'x', current_game: 'y' }), t).kind).toBe('none');
    });
    it('only on a phone: the custom status stays, the game does not (no controller)', () => {
        expect(statusLineModel(base({ custom_status_text: 'commuting', current_game: 'Chess', on_mobile: true }), t))
            .toMatchObject({ kind: 'custom', game: null, gameTooltip: null });
        expect(statusLineModel(base({ current_game: 'Chess', on_mobile: true }), t).kind).toBe('none');
    });
    it('an EXPIRED custom status is gone, but the game still shows', () => {
        const expired = new Date(t - MIN).toISOString();
        expect(statusLineModel(base({ custom_status_text: 'lunch', custom_status_expires_at: expired, current_game: 'Chess' }), t))
            .toMatchObject({ kind: 'game', game: 'Chess' });
        expect(statusLineModel(base({ custom_status_text: 'lunch', custom_status_expires_at: expired }), t).kind).toBe('none');
    });
    it('a status that has not expired yet still shows', () => {
        const later = new Date(t + MIN).toISOString();
        expect(statusLineModel(base({ custom_status_text: 'lunch', custom_status_expires_at: later }), t).kind).toBe('custom');
    });
});

describe('the dialog flow (draft -> issue -> payload)', () => {
    const draft = (over: Partial<CustomStatusDraft> = {}): CustomStatusDraft => ({ text: '', emoji: '', clearAfter: 'never', ...over });

    it('opens empty for no status, and prefilled (keeping the expiry) for an existing one', () => {
        expect(initialDraft(null)).toEqual(draft());
        const t = NOW.getTime();
        const at = new Date(t + 30 * MIN).toISOString();
        expect(initialDraft({ text: 'lunch', emoji: '🍜', expiresAt: at }, t)).toEqual({ text: 'lunch', emoji: '🍜', clearAfter: 'keep' });
        expect(initialDraft({ text: 'lunch', emoji: '', expiresAt: null }, t)).toEqual({ text: 'lunch', emoji: '', clearAfter: 'never' });
    });
    it('an already expired status opens as a blank dialog', () => {
        const t = NOW.getTime();
        expect(initialDraft({ text: 'old', emoji: '', expiresAt: new Date(t - MIN).toISOString() }, t)).toEqual(draft());
    });

    it('validates length, blank-only text, hidden characters and the profanity filter', () => {
        expect(draftIssue(draft({ text: 'x'.repeat(CUSTOM_STATUS_TEXT_MAX) }))).toBeNull();
        expect(draftIssue(draft({ text: 'x'.repeat(CUSTOM_STATUS_TEXT_MAX + 1) }))).toMatch(/100/);
        expect(draftIssue(draft({ text: '   ' }))).toMatch(/spaces/);
        expect(draftIssue(draft({ text: 'a‮b' }))).toMatch(/characters/);
        expect(draftIssue(draft({ text: 'fuck' }))).toMatch(/isn't allowed/);
        expect(draftIssue(draft({ text: 'working on it', emoji: '💻' }))).toBeNull();
        expect(draftIssue(draft())).toBeNull(); // empty = clear
    });

    it('builds the payload: text, emoji and the mapped expiry', () => {
        const p = draftPayload(draft({ text: 'lunch', emoji: '🍜', clearAfter: '1h' }), null, NOW);
        expect(p).toMatchObject({ text: 'lunch', emoji: '🍜' });
        expect(Date.parse(p.expiresAt!) - NOW.getTime()).toBe(60 * MIN);
        expect(draftPayload(draft({ text: 'hi', clearAfter: 'never' }), null, NOW).expiresAt).toBeNull();
    });
    it('"keep" re-sends the existing expiry while it is ahead, and drops it once it is not', () => {
        const ahead = new Date(NOW.getTime() + 10 * MIN).toISOString();
        const behind = new Date(NOW.getTime() - MIN).toISOString();
        expect(draftPayload(draft({ text: 'hi', clearAfter: 'keep' }), ahead, NOW).expiresAt).toBe(ahead);
        expect(draftPayload(draft({ text: 'hi', clearAfter: 'keep' }), behind, NOW).expiresAt).toBeNull();
    });
    it('an empty draft is a clear: no text, no emoji, no expiry', () => {
        expect(draftIsEmpty(draft())).toBe(true);
        expect(draftPayload(draft({ clearAfter: '4h' }), null, NOW)).toEqual({ text: '', emoji: '', expiresAt: null });
    });

    it('describeExpiry words the time, and says nothing for none or past', () => {
        expect(describeExpiry(null, NOW)).toBeNull();
        expect(describeExpiry(new Date(NOW.getTime() - MIN).toISOString(), NOW)).toBeNull();
        expect(describeExpiry(new Date(NOW.getTime() + 30 * MIN).toISOString(), NOW)).toMatch(/^Clears at /);
    });
});

describe('live updates carry the expiry (additive; old frames still work)', () => {
    const t = Date.now();
    it('toEntry keeps an active custom status with its expiry', () => {
        const at = new Date(t + 5 * MIN).toISOString();
        expect(toEntry({ user_id: 'u', status: 'online', custom_status_text: 'hi', custom_status_emoji: '👋', custom_status_expires_at: at }))
            .toMatchObject({ custom_status_text: 'hi', custom_status_emoji: '👋', custom_status_expires_at: at });
    });
    it('toEntry drops a custom status whose expiry has passed (a late frame)', () => {
        const e = toEntry({ user_id: 'u', status: 'online', custom_status_text: 'hi', custom_status_expires_at: new Date(t - MIN).toISOString() });
        expect(e.custom_status_text).toBeNull();
        expect(e.custom_status_expires_at).toBeUndefined();
    });
    it('a frame from an older server (no expiry field) still shows the status', () => {
        expect(toEntry({ user_id: 'u', status: 'online', custom_status_text: 'hi' }).custom_status_text).toBe('hi');
    });
    it('the expiry event clears it live', () => {
        const at = new Date(t + 5 * MIN).toISOString();
        let s = applyPresenceEvent({}, { kind: 'changed', entry: { user_id: 'u', status: 'online', custom_status_text: 'hi', custom_status_expires_at: at } });
        expect(s.u.custom_status_text).toBe('hi');
        s = applyPresenceEvent(s, { kind: 'changed', entry: { user_id: 'u', status: 'online', custom_status_text: null, custom_status_expires_at: null } });
        expect(s.u.custom_status_text).toBeNull();
    });
    it('own state: the expiry is read from GET /auth/me and presence:self', () => {
        const at = new Date(t + MIN).toISOString();
        expect(readServerOwnState({ chosen_status: 'online', custom_status_text: 'x', custom_status_emoji: '', custom_status_expires_at: at }))
            .toMatchObject({ expiresAt: at });
        expect(readServerOwnState({ chosen_status: 'online' })).toMatchObject({ expiresAt: null });
        expect(readSelfEvent({ status: 'dnd', custom_status_text: 'x', custom_status_emoji: '', custom_status_expires_at: at })?.choice.expiresAt).toBe(at);
    });
});
