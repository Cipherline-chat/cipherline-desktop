import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { memberRoleChips } from './memberRoleChips';
import type { Roster } from '../../../utils/serverRosterCache';

const role = (role_id: string, position: number, is_everyone = false) =>
    ({ role_id, name: role_id, color: -1, position, hoisted: false, is_everyone });
const member = (user_id: string, role_ids: string[]) => ({
    user_id, username: user_id, discriminator: null, nickname: null, avatar_url: null,
    status: 'offline', joined_at: '', muted_until: null, role_ids,
});
const roster: Roster = {
    roles: [role('everyone', 0, true), role('mod', 5), role('vip', 2), role('art', 3), role('dev', 4)],
    members: [member('a', ['vip', 'mod', 'everyone', 'art', 'dev']), member('b', [])],
};

describe('memberRoleChips', () => {
    it('highest position first, @everyone never shown, overflow counted', () => {
        const r = memberRoleChips(roster.roles, roster.members[0].role_ids, 3);
        expect(r.shown.map(x => x.role_id)).toEqual(['mod', 'dev', 'art']);
        expect(r.more).toBe(1);
    });
    it('no roster, unknown member, or no roles → nothing', () => {
        expect(memberRoleChips(null, ['mod'], 3)).toEqual({ shown: [], more: 0 });
        expect(memberRoleChips(roster.roles, undefined, 3)).toEqual({ shown: [], more: 0 });
        expect(memberRoleChips(roster.roles, [], 3)).toEqual({ shown: [], more: 0 });
    });
});

// Owner, 2026-11-16: "the ability to change roles on people from the members
// view in server settings". Wiring: the tab opens the shared role picker.
describe('Server Settings → Members: Roles', () => {
    const src = readFileSync(resolve(__dirname, '../ServerSettingsModal.tsx'), 'utf8');
    const tab = src.slice(src.indexOf('function MembersTab('), src.indexOf('// ── Invites Tab') > 0 ? src.indexOf('// ── Invites Tab') : undefined);
    it('opens the shared role picker for the row member, gated on canAssignRoles', () => {
        expect(tab).toContain('const canAssignRoles = !!rolePicker?.canAssignRoles(server.server_id);');
        expect(tab).toMatch(/\{canAssignRoles && muteTarget !== m\.user_id && \(\s*<ClButton[\s\S]{0,200}?onClick=\{e => openRoles\(m, e\)\}/);
        expect(tab).toMatch(/rolePicker\.open\(\{\s*serverId: server\.server_id,\s*userId: m\.user_id,/);
    });
    it('shows the member\'s role chips, optimistic via useMemberRoleIds', () => {
        expect(tab).toContain('<MemberRoleChipRow serverId={server.server_id} userId={m.user_id} token={token} />');
        const row = readFileSync(resolve(__dirname, 'MemberRoleChipRow.tsx'), 'utf8');
        expect(row).toContain('useMemberRoleIds(serverId, userId)');
    });
});
