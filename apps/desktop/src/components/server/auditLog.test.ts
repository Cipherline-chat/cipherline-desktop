import { describe, it, expect } from 'vitest';
import { describeAuditEntry, humanizeAction, permissionLabel, AUDIT_FILTER_OPTIONS, type AuditEntryLike } from './auditLog';

const e = (over: Partial<AuditEntryLike>): AuditEntryLike => ({
    id: 'e1', action: 'member.kick', actor_username: 'Alice', created_at: '2026-11-16T10:00:00.000Z', ...over,
});

describe('2026-11-17: divider categories and delete-with-contents', () => {
    it('category.update records turning into / out of a divider category, and its style / colour', () => {
        const to = describeAuditEntry(e({ action: 'category.update', data_jsonb: { name: 'Games', before: { name: 'Games', header_style: null }, after: { name: 'Games', header_style: 'pill', header_color: '#25e0c8' } } }));
        expect(to.sentence).toBe('Alice edited the category "Games"');
        expect(to.details).toContain('Now a divider category (pill style)');
        const back = describeAuditEntry(e({ action: 'category.update', data_jsonb: { name: 'Games', before: { header_style: 'pill' }, after: { header_style: null } } }));
        expect(back.details).toContain('Now an ordinary category');
        const restyle = describeAuditEntry(e({ action: 'category.update', data_jsonb: { name: 'Games', before: { header_style: 'pill', header_color: null }, after: { header_style: 'label', header_color: '#ff6b5e' } } }));
        expect(restyle.details).toEqual(expect.arrayContaining(['Divider style changed from pill to label', 'Divider colour changed']));
    });

    it('category.delete with contents says "and everything in it" with the counts and channel names', () => {
        const d = describeAuditEntry(e({ action: 'category.delete', data_jsonb: {
            name: 'Games', with_contents: true, channels_deleted: 2, subcategories_deleted: 1, dividers_deleted: 2,
            channels: [{ id: 'a', name: 'lobby' }, { id: 'b', name: 'joinery' }], server_saved_destroyed: 3, calls_ended: 1,
        } }));
        expect(d.sentence).toBe('Alice deleted the category "Games" and everything in it');
        expect(d.details).toEqual(['Deleted 2 channels, 1 sub-category, 2 dividers', '#lobby', '#joinery', '3 server-saved messages destroyed', '1 live call ended']);
        expect(d.tone).toBe('danger');
    });

    it('subcategory.delete with contents, and the plain deletes are unchanged', () => {
        expect(describeAuditEntry(e({ action: 'subcategory.delete', data_jsonb: { name: 'Wood', with_contents: true, channels_deleted: 1 } })).sentence)
            .toBe('Alice deleted the sub-category "Wood" and everything in it');
        expect(describeAuditEntry(e({ action: 'category.delete', data_jsonb: { name: 'Games' } })).sentence)
            .toBe('Alice deleted the category "Games"');
    });
});

describe('describeAuditEntry: owner-facing sentences', () => {
    it('role given: who, to whom, which role', () => {
        const d = describeAuditEntry(e({
            action: 'member.role_added', target_user_id: 'u2', target_username: 'Bob', target_role_id: 'r1',
            target_role_name: 'Moderator', data_jsonb: { role_name: 'Moderator' },
        }));
        expect(d.sentence).toBe('Alice gave Bob the Moderator role');
        expect(d.icon).toBe('role');
    });

    it('role removed, and the role name survives the role being deleted (payload fallback)', () => {
        const d = describeAuditEntry(e({
            action: 'member.role_removed', target_username: 'Bob', target_role_id: 'gone', target_role_name: null,
            data_jsonb: { role_name: 'Moderator' },
        }));
        expect(d.sentence).toBe('Alice removed the Moderator role from Bob');
    });

    it('role edit lists the name change and permissions gained / lost with friendly labels', () => {
        const d = describeAuditEntry(e({
            action: 'role.update',
            data_jsonb: {
                name: 'VIP+', before: { name: 'VIP', hoisted: false }, after: { name: 'VIP+', hoisted: true },
                permissions_added: ['MANAGE_ROLES', 'KICK_MEMBERS'], permissions_removed: ['SEND_MESSAGES'],
            },
        }));
        expect(d.sentence).toBe('Alice edited the role "VIP+"');
        expect(d.details).toEqual([
            'Name: "VIP" to "VIP+"',
            'Now shown separately in the member list',
            'Gained: Manage Roles, Kick Members',
            'Lost: Send Messages',
        ]);
    });

    it('role create / delete', () => {
        expect(describeAuditEntry(e({ action: 'role.create', data_jsonb: { name: 'Helper', permissions: ['KICK_MEMBERS'] } })).sentence)
            .toBe('Alice created the role "Helper"');
        expect(describeAuditEntry(e({ action: 'role.delete', data_jsonb: { name: 'Helper' } })).sentence)
            .toBe('Alice deleted the role "Helper"');
    });

    it('sub-category moved into a parent (names resolved by the API)', () => {
        const d = describeAuditEntry(e({
            action: 'subcategory.move',
            names: { s1: 'Late Night', p2: 'Gaming' },
            data_jsonb: { category_id: 's1', name: 'Late Night', before: { parent_category_id: 'p1' }, after: { parent_category_id: 'p2' } },
        }));
        expect(d.sentence).toBe('Alice moved the sub-category "Late Night" into "Gaming"');
    });

    it('sub-category promoted to the top level, and a category demoted into a parent', () => {
        expect(describeAuditEntry(e({
            action: 'subcategory.move', data_jsonb: { name: 'Late Night', before: { parent_category_id: 'p1' }, after: { parent_category_id: null } },
        })).sentence).toBe('Alice moved the sub-category "Late Night" out to the top level');
        expect(describeAuditEntry(e({
            action: 'subcategory.move', names: { p2: 'Gaming' },
            data_jsonb: { name: 'Chat', before: { parent_category_id: null }, after: { parent_category_id: 'p2' } },
        })).sentence).toBe('Alice made the category "Chat" a sub-category of "Gaming"');
    });

    it('sub-category create / rename / delete', () => {
        expect(describeAuditEntry(e({ action: 'subcategory.create', names: { p: 'Gaming' }, data_jsonb: { name: 'Late Night', parent_category_id: 'p' } })).sentence)
            .toBe('Alice created the sub-category "Late Night" in "Gaming"');
        expect(describeAuditEntry(e({ action: 'subcategory.update', data_jsonb: { before: { name: 'a' }, after: { name: 'b' } } })).sentence)
            .toBe('Alice renamed the sub-category "a" to "b"');
        const del = describeAuditEntry(e({ action: 'subcategory.delete', names: { p: 'Gaming' }, data_jsonb: { name: 'Late Night', parent_category_id: 'p' } }));
        expect(del.sentence).toBe('Alice deleted the sub-category "Late Night"');
        expect(del.details).toEqual(['Its contents moved up into "Gaming"']);
    });

    it('dividers, including the Calls panel', () => {
        expect(describeAuditEntry(e({ action: 'divider.create', data_jsonb: { label: 'Community', list_kind: 'text' } })).sentence)
            .toBe('Alice created the divider "Community"');
        expect(describeAuditEntry(e({ action: 'divider.create', data_jsonb: { label: 'Hub', list_kind: 'calls' } })).sentence)
            .toBe('Alice created the divider "Hub" in the Calls panel');
        expect(describeAuditEntry(e({ action: 'divider.delete', data_jsonb: { label: null, style: 'line' } })).sentence)
            .toBe('Alice deleted a divider');
        const up = describeAuditEntry(e({ action: 'divider.update', data_jsonb: { before: { label: 'A' }, after: { label: 'B' } } }));
        expect(up.sentence).toBe('Alice edited the divider "B"');
        expect(up.details).toEqual(['Label: "A" to "B"']);
    });

    it('layout update: one move reads as a sentence, several as a list with a total', () => {
        const one = describeAuditEntry(e({
            action: 'layout.update', names: { g: 'Gaming' },
            data_jsonb: { moves: [{ kind: 'subcategory', id: 's', name: 'Late Night', from: null, to: 'g' }], moved: 1, reordered: 2 },
        }));
        expect(one.sentence).toBe('Alice moved the sub-category "Late Night" into "Gaming"');
        expect(one.details).toEqual(['2 other items changed position']);
        const many = describeAuditEntry(e({
            action: 'layout.update', names: { g: 'Gaming' },
            data_jsonb: { moves: [
                { kind: 'channel', id: 'c1', name: 'general', from: null, to: 'g' },
                { kind: 'divider', id: 'd1', name: 'x', from: 'g', to: null },
            ], moved: 5, reordered: 0 },
        }));
        expect(many.sentence).toBe('Alice rearranged the channel list');
        expect(many.details).toEqual([
            'Moved channel #general from the top level to "Gaming"',
            'Moved divider "x" from "Gaming" to the top level',
            '...and 3 more',
        ]);
    });

    it('channel edits: rename, icon, move each read as one sentence; several changes list them', () => {
        const base = { action: 'channel.update', names: { a: 'Old', b: 'New' } };
        expect(describeAuditEntry(e({ ...base, data_jsonb: { before: { name: 'x' }, after: { name: 'y' } } })).sentence)
            .toBe('Alice renamed #x to #y');
        expect(describeAuditEntry(e({ ...base, data_jsonb: { before: { name: 'x', icon_name: 'Hash' }, after: { name: 'x', icon_name: 'Radio' } } })).sentence)
            .toBe('Alice changed the icon of #x');
        expect(describeAuditEntry(e({ ...base, data_jsonb: { before: { name: 'x', parent_category_id: 'a' }, after: { name: 'x', parent_category_id: 'b' } } })).sentence)
            .toBe('Alice moved #x from "Old" to "New"');
        const multi = describeAuditEntry(e({ ...base, data_jsonb: { before: { name: 'x', topic: null, icon_name: 'a' }, after: { name: 'y', topic: 't', icon_name: 'b' } } }));
        expect(multi.sentence).toBe('Alice edited #y');
        expect(multi.details).toEqual(['Renamed #x to #y', 'Topic changed', 'Icon changed']);
    });

    it('permission overrides name the target, the channel / category and the permission changes', () => {
        const ch = describeAuditEntry(e({
            action: 'channel.override.update', target_channel_id: 'c', target_channel_name: 'staff', names: { r: 'Moderator' },
            data_jsonb: { target_kind: 'role', target_id: 'r', allow_names: ['VIEW_CHANNEL'], deny_names: [], before_deny_names: ['VIEW_CHANNEL'] },
        }));
        expect(ch.sentence).toBe('Alice changed the permissions of the Moderator role on #staff');
        expect(ch.details).toEqual(['Allowed: View Channels', 'Before: denied View Channels']);
        const cat = describeAuditEntry(e({
            action: 'category.override.delete', names: { u: 'Bob', cat: 'Staff' },
            data_jsonb: { category_id: 'cat', target_kind: 'member', target_id: 'u' },
        }));
        expect(cat.sentence).toBe('Alice removed the permission override of Bob on the category "Staff"');
    });

    it('server settings list only what changed', () => {
        const d = describeAuditEntry(e({
            action: 'server.update',
            data_jsonb: { before: { name: 'A', icon_attachment: null }, after: { name: 'B', icon_attachment: 'att' } },
        }));
        expect(d.sentence).toBe('Alice changed the server settings');
        expect(d.details).toEqual(['Name: "A" to "B"', 'Icon changed']);
    });

    it('moderation and invites keep their wording; reasons and durations show as details', () => {
        const mute = describeAuditEntry(e({ action: 'member.mute', target_username: 'Bob', data_jsonb: { duration_seconds: 3600, reason: 'spam' } }));
        expect(mute.sentence).toBe('Alice muted Bob');
        expect(mute.details).toEqual(['For 1 hour', 'Reason: spam']);
        expect(describeAuditEntry(e({ action: 'member.ban', target_username: 'Bob' })).tone).toBe('danger');
        expect(describeAuditEntry(e({ action: 'invite.create', data_jsonb: { code: 'SECRETCODE', max_uses: 5 } })).details).toEqual(['5 uses allowed']);
    });

    it('never renders an invite code', () => {
        const all = [
            describeAuditEntry(e({ action: 'invite.create', data_jsonb: { code: 'SECRETCODE' } })),
            describeAuditEntry(e({ action: 'invite.delete', data_jsonb: { code: 'SECRETCODE' } })),
            describeAuditEntry(e({ action: 'member.join', data_jsonb: { code: 'SECRETCODE' } })),
        ];
        expect(JSON.stringify(all)).not.toContain('SECRETCODE');
    });
});

describe('describeAuditEntry: robustness', () => {
    it('an action from a newer server renders a humanised fallback, not a crash', () => {
        const d = describeAuditEntry(e({ action: 'soundboard.clip_added', data_jsonb: { x: 1 } }));
        expect(d.sentence).toBe('Alice: Soundboard clip added');
        expect(d.icon).toBe('info');
    });

    it.each([null, undefined, 'a string', 42, [], [1, 2], { before: 'oops', after: 7 }, { moves: 'nope', names: 3 }])(
        'a malformed payload %j never throws, for every known action',
        (payload) => {
            for (const o of AUDIT_FILTER_OPTIONS) {
                if (!o.value) continue;
                const d = describeAuditEntry(e({ action: o.value, data_jsonb: payload, names: payload as any }));
                expect(typeof d.sentence).toBe('string');
                expect(d.sentence.length).toBeGreaterThan(0);
                expect(Array.isArray(d.details)).toBe(true);
            }
        },
    );

    it('a null actor and a missing action still render', () => {
        expect(describeAuditEntry(e({ actor_username: null, action: 'role.create', data_jsonb: { name: 'X' } })).sentence)
            .toBe('Someone created the role "X"');
        expect(describeAuditEntry({ id: 'x', created_at: '' } as any).sentence).toBe('Someone: Unknown action');
    });

    it('details are capped', () => {
        const moves = Array.from({ length: 25 }, (_, i) => ({ kind: 'channel', id: `c${i}`, name: `n${i}`, from: null, to: null }));
        const d = describeAuditEntry(e({ action: 'channel.reorder', data_jsonb: { count: 25, moves, moved: 25 } }));
        expect(d.details.length).toBeLessThanOrEqual(8);
    });

    it('positive control: the robustness loop really exercises the describers (a known payload gives a specific sentence)', () => {
        expect(describeAuditEntry(e({ action: 'role.delete', data_jsonb: { name: 'X' } })).sentence).toBe('Alice deleted the role "X"');
    });
});

describe('helpers', () => {
    it('humanizeAction', () => {
        expect(humanizeAction('future.thing_happened')).toBe('Future thing happened');
        expect(humanizeAction('')).toBe('Unknown action');
        expect(humanizeAction(undefined as any)).toBe('Unknown action');
    });

    it('permissionLabel uses the role editor wording and humanises an unknown bit', () => {
        expect(permissionLabel('MANAGE_ROLES')).toBe('Manage Roles');
        expect(permissionLabel('BRAND_NEW_BIT')).toBe('Brand new bit');
    });

    it('the filter offers every new action and no duplicates', () => {
        const values = AUDIT_FILTER_OPTIONS.map(o => o.value);
        for (const a of ['subcategory.create', 'subcategory.update', 'subcategory.move', 'subcategory.delete', 'divider.create', 'layout.update', 'member.role_added', 'role.update']) {
            expect(values).toContain(a);
        }
        expect(new Set(values).size).toBe(values.length);
    });
});
