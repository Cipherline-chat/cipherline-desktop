// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { formatMemberSince, memberSinceDayOf, parseMemberSinceDay } from './memberSince';
import { hasGrants, parseGrants } from './discordClaims';

describe('member since', () => {
    it('a stored day is shown as that day, in UTC (no off-by-one in a western time zone)', () => {
        expect(formatMemberSince('2019-04-02')).toBe('Apr 2, 2019');
        expect(formatMemberSince('2016-01-01')).toBe('Jan 1, 2016');
    });

    it('the imported day wins over the Cipherline join day; without one, the join day', () => {
        expect(memberSinceDayOf({ member_since: '2019-04-02', joined_at: '2026-11-22T10:00:00.000Z' })).toEqual({ day: '2019-04-02', imported: true });
        expect(memberSinceDayOf({ member_since: null, joined_at: '2026-11-22T10:00:00.000Z' })).toEqual({ day: '2026-11-22', imported: false });
        expect(memberSinceDayOf({ joined_at: 'nope' })).toBeNull();
        expect(memberSinceDayOf(undefined)).toBeNull();
    });

    it('garbled or forged values are not shown', () => {
        for (const bad of ['2021-02-30', '2019-4-2', '<b>2019</b>', 20190402, null, undefined, '2019-04-02T00:00:00Z']) {
            expect(parseMemberSinceDay(bad)).toBeNull();
        }
        expect(memberSinceDayOf({ member_since: '2021-02-30', joined_at: '2026-01-01T00:00:00Z' })).toEqual({ day: '2026-01-01', imported: false });
    });

    it('a claim with only a member-since day is still "something besides messages"; a bad day is not', () => {
        const g = parseGrants({ roles: [], overrides: 0, nickname: null, banned: false, member_since: '2016-01-05' });
        expect(g?.member_since).toBe('2016-01-05');
        expect(hasGrants({ grants: g })).toBe(true);
        expect(parseGrants({ roles: [], overrides: 0, member_since: 'soon' })).toBeNull();
        // An older API (no field): unchanged behaviour.
        expect(parseGrants({ roles: [], overrides: 1 })?.member_since).toBeNull();
    });
});
