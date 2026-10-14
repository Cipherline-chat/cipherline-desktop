import { describe, it, expect } from 'vitest';
import { deriveMentionRoster, EMPTY_MENTION_VIEW } from './mentionRoster';
import type { Roster, RosterMember, RosterRole } from './serverRosterCache';

const member = (id: string, extra: Partial<RosterMember> = {}): RosterMember => ({
    user_id: id, username: `u-${id}`, discriminator: 7, nickname: null, avatar_url: null,
    status: 'online', joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids: [], ...extra,
});
const role = (id: string, extra: Partial<RosterRole> = {}): RosterRole => ({
    role_id: id, name: `r-${id}`, color: 255, position: 1, hoisted: false, is_everyone: false, mentionable: true, ...extra,
});

describe('deriveMentionRoster', () => {
    it('null roster -> the empty view (only @everyone / @here tokens)', () => {
        const v = deriveMentionRoster(null, 'me');
        expect(v).toBe(EMPTY_MENTION_VIEW);
        expect(v.members).toEqual([]);
        expect(Object.keys(v.tokenMap).sort()).toEqual(['everyone', 'here']);
    });

    it('members, non-everyone roles and the wire-token map all come from the roster', () => {
        const roster: Roster = {
            members: [member('1'), member('2', { discriminator: null })],
            roles: [role('r1'), role('re', { is_everyone: true, name: '@everyone' })],
        };
        const v = deriveMentionRoster(roster, 'me');
        expect(v.members).toEqual([
            { user_id: '1', username: 'u-1', discriminator: 7 },
            { user_id: '2', username: 'u-2', discriminator: null },
        ]);
        expect(v.roles.map(r => r.role_id)).toEqual(['r1']);          // @everyone role is not offered
        expect(v.tokenMap['u-1']).toBe('<@u:1:u-1>');
        expect(v.tokenMap['r-r1']).toBe('<@r:r1:r-r1>');
        expect(v.tokenMap.everyone).toBe('@everyone');
    });

    it("the viewer's own role ids are read from their own roster row (array or pg-string form)", () => {
        const base = { roles: [] as RosterRole[] };
        expect(deriveMentionRoster({ ...base, members: [member('me', { role_ids: ['a', 'b'] })] }, 'me').myRoleIds).toEqual(['a', 'b']);
        expect(deriveMentionRoster({ ...base, members: [member('me', { role_ids: '{a,b}' as unknown as string[] })] }, 'me').myRoleIds).toEqual(['a', 'b']);
        expect(deriveMentionRoster({ ...base, members: [member('x', { role_ids: ['a'] })] }, 'me').myRoleIds).toEqual([]);
        expect(deriveMentionRoster({ ...base, members: [member('me', { role_ids: ['a'] })] }, null).myRoleIds).toEqual([]);
    });
});
