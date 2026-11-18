import { describe, it, expect } from 'vitest';
import { mentionAudienceCount, needsEveryoneConfirm, everyoneConfirmCopy } from './composerFun';

// Owner, 2026-11-17: "when I mention @everyone or @here in a channel that only has a small amount of people in I get
// the warning saying I am going to ping all 1000 members which is not true". The count is now the channel's audience.

const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: `u${i}` }));
const ALL = { kind: 'all' as const };
const LOADING = { kind: 'loading' as const };
const subset = (ids: string[]) => ({ kind: 'subset' as const, ids: new Set(ids) });

describe('mentionAudienceCount', () => {
    it('a restricted channel counts only the members who can see it, not the server', () => {
        expect(mentionAudienceCount(roster(1000), subset(['u0', 'u1', 'u2', 'u3']), 'u0')).toBe(3);
    });
    it('a public channel counts the whole roster minus the sender', () => {
        expect(mentionAudienceCount(roster(1000), ALL, 'u0')).toBe(999);
    });
    it('before a restricted channel has an answer, the full roster is the upper bound (the dialog never vanishes)', () => {
        expect(mentionAudienceCount(roster(150), LOADING, 'u0')).toBe(149);
    });
    it('viewer ids that are not in the roster are not counted', () => {
        expect(mentionAudienceCount(roster(3), subset(['u1', 'ghost']), 'u0')).toBe(1);
    });
    it('no roster yet = unknown (null), and the sender alone = 0', () => {
        expect(mentionAudienceCount([], ALL, 'u0')).toBeNull();
        expect(mentionAudienceCount(null, ALL, 'u0')).toBeNull();
        expect(mentionAudienceCount(roster(1), ALL, 'u0')).toBe(0);
    });
});

describe('the confirm uses the audience, so a small channel in a big server does not ask', () => {
    const ask = (memberCount: number | null) => needsEveryoneConfirm({
        mentions: [{ type: 'everyone' }], memberCount, isServerChannel: true, canMention: true, isEdit: false, alreadyConfirmed: false,
    });
    it('5 people in a restricted channel of a 1000-member server: no dialog', () => {
        expect(ask(mentionAudienceCount(roster(1000), subset(['u0', 'u1', 'u2', 'u3', 'u4']), 'u0'))).toBe(false);
    });
    it('positive control: the old count (the whole server) asks', () => {
        expect(ask(roster(1000).length)).toBe(true);
    });
    it('a big restricted channel still asks, with its own number', () => {
        const ids = roster(400).map(m => m.user_id);
        const n = mentionAudienceCount(roster(1000), subset(ids), 'u0')!;
        expect(n).toBe(399);
        expect(ask(n)).toBe(true);
        expect(everyoneConfirmCopy('everyone', n).message).toBe('This will notify 399 members.');
    });
});
