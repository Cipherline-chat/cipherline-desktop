import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Permissions as P, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import {
    categoryRestrictsView, categoryDeleteConfirm, privateParentMessage,
    categoryContents, contentsSummary, deleteEverythingLabel, expectedCounts, isEmptyContents,
} from './categoryDelete';
import type { PermOverride, PermRole } from './channelPerms/effectivePermissions';

describe('delete with contents: counts and copy (2026-11-17)', () => {
    const cats = [
        { category_id: 'games', parent_category_id: null },
        { category_id: 'wood', parent_category_id: 'games' },
        { category_id: 'print', parent_category_id: 'games' },
        { category_id: 'other', parent_category_id: null },
        { category_id: 'pending:x', parent_category_id: 'games' },
    ];
    const chans = [
        { channel_id: 'lobby', parent_category_id: 'games' },
        { channel_id: 'joinery', parent_category_id: 'wood' },
        { channel_id: 'press', parent_category_id: 'print' },
        { channel_id: 'general', parent_category_id: null },
        { channel_id: 'elsewhere', parent_category_id: 'other' },
        { channel_id: 'pending:new', parent_category_id: 'games' },
    ];
    const divs = [
        { divider_id: 'd1', parent_category_id: 'games' },
        { divider_id: 'd2', parent_category_id: 'wood' },
        { divider_id: 'd3', parent_category_id: null },
        { divider_id: 'd4', parent_category_id: 'other' },
    ];

    it('a top-level category counts its own items AND its sub-categories\' (never pending, never others)', () => {
        const c = categoryContents('games', { categories: cats, channels: chans, dividers: divs });
        expect(c).toEqual({ channels: 3, subcategories: 2, dividers: 2, channelIds: ['lobby', 'joinery', 'press'] });
        expect(expectedCounts(c)).toEqual({ expected_channels: 3, expected_subcategories: 2, expected_dividers: 2 });
    });

    it('a sub-category counts only its own items', () => {
        expect(categoryContents('wood', { categories: cats, channels: chans, dividers: divs }))
            .toEqual({ channels: 1, subcategories: 0, dividers: 1, channelIds: ['joinery'] });
    });

    it('summary and button wording', () => {
        expect(contentsSummary({ channels: 3, subcategories: 2, dividers: 2 })).toBe('3 channels, 2 sub-categories and 2 dividers');
        expect(contentsSummary({ channels: 1, subcategories: 0, dividers: 1 })).toBe('1 channel and 1 divider');
        expect(contentsSummary({ channels: 0, subcategories: 0, dividers: 0 })).toBe('nothing');
        expect(deleteEverythingLabel({ channels: 1 })).toBe('Delete 1 channel');
        expect(deleteEverythingLabel({ channels: 0 })).toBe('Delete everything');
        expect(isEmptyContents({ channels: 0, subcategories: 0, dividers: 0 })).toBe(true);
    });

    it('"category only" in the Calls panel says where the channels go (the old copy wrongly said they were deleted)', () => {
        const c = categoryDeleteConfirm({ name: 'Lounges', isSub: false, hasSubcategories: false, isPrivate: null, panel: 'calls' });
        expect(c.message).toBe('Its Calls channels and dividers move to the top of the Calls panel, outside any category.');
        const panel = readFileSync(resolve(__dirname, 'ServerContextPanel.tsx'), 'utf8');
        expect(panel).not.toContain('All Calls channels inside will also be deleted');
    });

    it('wiring: both panels delete the subtree in ONE request, never channel by channel', () => {
        const list = readFileSync(resolve(__dirname, 'ServerChannelList.tsx'), 'utf8');
        const panel = readFileSync(resolve(__dirname, 'ServerContextPanel.tsx'), 'utf8');
        const dash = readFileSync(resolve(__dirname, '../Dashboard.tsx'), 'utf8');
        expect(dash).toContain('/categories/${cat.category_id}/delete-with-contents');
        expect(panel).toContain('/categories/${cat.category_id}/delete-with-contents');
        const withContents = list.slice(list.indexOf('const deleteCategoryWithContentsNow'), list.indexOf('const requestDeleteCategory'));
        expect(withContents).toContain('onDeleteCategoryWithContentsApi(cat, expectedCounts(contents))');
        expect(withContents).not.toMatch(/for \(|\.forEach\(|onDeleteChannelApi/);
    });
});

// Owner decision 2026-11-16: a PRIVATE top-level category that still holds
// sub-categories cannot be deleted (server: 409). The client says so up front.

const EV = 'ev', VIP = 'vip', ADMIN = 'admin';
const roles: PermRole[] = [
    { role_id: EV, name: '@everyone', position: 0, is_everyone: true, permissions: DEFAULT_EVERYONE_PERMISSIONS },
    { role_id: VIP, name: 'VIP', position: 5, is_everyone: false, permissions: 0n },
    { role_id: ADMIN, name: 'Admin', position: 10, is_everyone: false, permissions: P.ADMINISTRATOR },
];
const ov = (target_kind: 'role' | 'member', target_id: string, allow: bigint, deny: bigint): PermOverride =>
    ({ target_kind, target_id, allow, deny });
const V = P.VIEW_CHANNEL;

describe('categoryRestrictsView (mirror of PermissionsService.categoryRestrictsViewFrom)', () => {
    it.each([
        ['no overrides', [], false],
        ['@everyone denied VIEW', [ov('role', EV, 0n, V)], true],
        ['one role denied VIEW', [ov('role', VIP, 0n, V)], true],
        ['a member denied VIEW', [ov('member', 'u1', 0n, V)], true],
        ['only an ALLOW of VIEW', [ov('role', VIP, V, 0n)], false],
        ['@everyone denied, re-allowed to a role', [ov('role', EV, 0n, V), ov('role', VIP, V, 0n)], true],
        ['a deny of another bit', [ov('role', EV, 0n, P.SEND_MESSAGES)], false],
        ['a deny only an ADMINISTRATOR role gets (overrides never apply)', [ov('role', ADMIN, 0n, V)], false],
    ] as Array<[string, PermOverride[], boolean]>)('%s -> %s', (_n, overrides, expected) => {
        expect(categoryRestrictsView(roles, overrides)).toBe(expected);
    });
});

describe('categoryDeleteConfirm', () => {
    it('private parent WITH sub-categories: Delete disabled, the server\'s wording, and the way out', () => {
        const c = categoryDeleteConfirm({ name: 'Staff', isSub: false, hasSubcategories: true, isPrivate: true });
        expect(c.confirmDisabled).toBe(true);
        expect(c.message).toBe(privateParentMessage('Staff'));
        expect(c.message).toBe(`Move or delete the sub-categories in "Staff" first. It's private, and deleting it would make them visible to everyone who can see the server.`);
        expect(c.hint).toMatch(/Sits in/);
    });

    it('private parent with NO sub-categories, or a public parent with them: deletable', () => {
        expect(categoryDeleteConfirm({ name: 'Staff', isSub: false, hasSubcategories: false, isPrivate: true }).confirmDisabled).toBeFalsy();
        const pub = categoryDeleteConfirm({ name: 'Crafting', isSub: false, hasSubcategories: true, isPrivate: false });
        expect(pub.confirmDisabled).toBeFalsy();
        expect(pub.message).toMatch(/sub-categories become categories/);
    });

    it('unknown privacy (overrides failed to load): let the server decide', () => {
        expect(categoryDeleteConfirm({ name: 'X', isSub: false, hasSubcategories: true, isPrivate: null }).confirmDisabled).toBeFalsy();
    });

    it('a sub-category: its items move up into the parent', () => {
        expect(categoryDeleteConfirm({ name: 'Wood', isSub: true, parentName: 'Crafting', hasSubcategories: false, isPrivate: null }).message)
            .toBe('Its channels and dividers move up into ‘Crafting’.');
    });
});

describe('wiring', () => {
    const list = readFileSync(resolve(__dirname, 'ServerChannelList.tsx'), 'utf8');
    const confirm = readFileSync(resolve(__dirname, '../primitives/ConfirmDialog.tsx'), 'utf8');

    it('every category delete (menu and the edit dialog) goes through the pre-check', () => {
        expect(list).toContain("onSelect: () => { void requestDeleteCategory(cat); },");
        expect(list).toContain('onDelete={onDeleteCategoryApi ? (cat) => { void requestDeleteCategory(cat); } : undefined}');
        expect(list).toContain('categoryRestrictsView(');
    });

    it('a refusal shows the server\'s message', () => {
        const del = list.slice(list.indexOf('const deleteCategoryNow'), list.indexOf('const requestDeleteCategory'));
        expect(del).toContain('errMsg(e) ??');
    });

    // Owner, 2026-11-16: removed. The way out is Edit -> "Sits in", or a drag.
    it('no "Move to top level" and no separate "Edit Permissions" in the category menu', () => {
        const menu = list.slice(list.indexOf('const buildCategoryMenu'), list.indexOf('const buildDividerMenu'));
        expect(list).not.toContain("label: 'Move to top level'");
        expect(list).not.toContain('const moveToTopLevel');
        expect(menu).not.toContain("label: 'Edit Permissions'");
        expect(menu).toContain('label: `Edit ${noun}`');
    });

    it('categories and sub-categories share ONE menu; only the by-design items differ', () => {
        const menu = list.slice(list.indexOf('const buildCategoryMenu'), list.indexOf('const buildDividerMenu'));
        for (const label of ["label: 'Mark as Read'", "label: 'Create Channel Here'", "label: 'Add Divider Here'", 'label: `Edit ${noun}`',
            'label: `Copy ${noun} ID`', 'label: `Delete ${noun}`']) {
            expect(menu).toContain(label);
        }
        // One level of nesting: no "Create Sub-category Here" on a sub-category.
        expect(menu).toMatch(/\.\.\.\(!isSub \? \[\{\s*icon: <CornerDownRight \/>, label: 'Create Sub-category Here'/);
        // Members get the menu too (Mark as Read, Copy ID); writes stay manager-only.
        expect(list).not.toContain("if (!canManage) { e.preventDefault(); return; }\n                                ctx.open(e, buildCategoryMenu");
    });

    it('a blocked delete shows no Delete button at all, only a primary "Got it" that closes', () => {
        const footer = confirm.slice(confirm.indexOf('<DialogFooter'), confirm.indexOf('</DialogFooter>'));
        expect(footer).toContain('{confirmDisabled ? (');
        expect(footer).toContain('<ClButton size="sm" onClick={() => startClose(onCancel)}>Got it</ClButton>');
        // The danger confirm only exists on the other branch.
        expect(footer.slice(footer.indexOf(') : ('))).toContain('variant="danger"');
        expect(footer.slice(0, footer.indexOf(') : ('))).not.toContain('variant="danger"');
    });
});
