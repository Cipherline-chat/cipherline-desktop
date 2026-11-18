import { describe, it, expect } from 'vitest';
import {
    memberGroupsCollapsedKey, parseCollapsed, serializeCollapsed,
    toggleCollapsed, pruneCollapsed, validMemberGroupIds, planSections, expandedRowTotal,
    roleGroupId, ONLINE_GROUP_ID, OFFLINE_GROUP_ID, MAX_STORED_GROUP_IDS,
} from './memberGroupCollapse';
import { classifyKvKey } from '../services/backupRegistry';
import { allocateRows } from './incrementalRows';

const UID = 'u-123';

describe('storage keys', () => {
    it('are per account and per server', () => {
        expect(memberGroupsCollapsedKey(UID, 's1')).toBe('cipherline_member_groups_collapsed_u-123_s1');
        expect(memberGroupsCollapsedKey(UID, 's1')).not.toBe(memberGroupsCollapsedKey(UID, 's2'));
        expect(memberGroupsCollapsedKey('u-9', 's1')).not.toBe(memberGroupsCollapsedKey(UID, 's1'));
    });

    it('the keys the builders produce are classified in backupRegistry', () => {
        expect(classifyKvKey(memberGroupsCollapsedKey(UID, 'srv'), UID)).not.toBe('unknown');
    });
});

describe('parse / serialize', () => {
    it('round-trips, sorted and stable', () => {
        const s = new Set(['role:b', 'offline', 'role:a']);
        const raw = serializeCollapsed(s);
        expect(raw).toBe('["offline","role:a","role:b"]');
        expect(parseCollapsed(raw)).toEqual(s);
    });

    it('anything malformed reads as nothing collapsed', () => {
        for (const raw of [null, undefined, '', 'nope', '{}', '{"offline":true}', '42', 'null']) {
            expect(parseCollapsed(raw as string | null)).toEqual(new Set());
        }
        expect(parseCollapsed('["online", 5, null, "", "offline"]')).toEqual(new Set(['online', 'offline']));
    });

    it('caps a hostile record', () => {
        const big = JSON.stringify(Array.from({ length: MAX_STORED_GROUP_IDS * 3 }, (_, i) => `role:${i}`));
        expect(parseCollapsed(big).size).toBe(MAX_STORED_GROUP_IDS);
        expect(parseCollapsed(JSON.stringify(['x'.repeat(129), 'ok']))).toEqual(new Set(['ok']));
    });
});

describe('toggle', () => {
    it('adds then removes, never mutating its input', () => {
        const a = new Set<string>();
        const b = toggleCollapsed(a, 'online');
        expect(a.size).toBe(0);
        expect(b).toEqual(new Set(['online']));
        expect(toggleCollapsed(b, 'online')).toEqual(new Set());
    });
});

describe('pruning stale ids', () => {
    const roles = [
        { role_id: 'mods', hoisted: true },
        { role_id: 'vip', hoisted: false },
        { role_id: 'everyone', hoisted: true, is_everyone: true },
    ];

    it('valid ids = online, offline, and hoisted non-@everyone roles', () => {
        expect(validMemberGroupIds(roles)).toEqual(new Set([ONLINE_GROUP_ID, OFFLINE_GROUP_ID, roleGroupId('mods')]));
    });

    it('drops deleted and un-hoisted roles, keeps the rest', () => {
        const stored = new Set(['online', 'role:mods', 'role:deleted', 'role:vip']);
        expect(pruneCollapsed(stored, validMemberGroupIds(roles))).toEqual(new Set(['online', 'role:mods']));
    });

    it('returns the same instance when nothing is stale (so callers skip the write)', () => {
        const stored = new Set(['offline', 'role:mods']);
        expect(pruneCollapsed(stored, validMemberGroupIds(roles))).toBe(stored);
    });

    it('a renamed role keeps its id, so it is not pruned', () => {
        const stored = new Set(['role:mods']);
        const renamed = [{ role_id: 'mods', hoisted: true, name: 'Moderators' }];
        expect(pruneCollapsed(stored, validMemberGroupIds(renamed))).toBe(stored);
    });
});

describe('planSections (row budget with collapsed groups)', () => {
    it('with nothing collapsed it is exactly allocateRows', () => {
        const counts = [10, 20, 100];
        for (const budget of [0, 5, 30, 48, 500]) {
            const plan = planSections(counts, [false, false, false], budget);
            expect(plan.map(p => p.rows)).toEqual(allocateRows(counts, budget));
            expect(plan.map(p => p.showHeader)).toEqual(allocateRows(counts, budget).map(r => r > 0));
        }
    });

    it('a collapsed group costs no budget and still shows its header', () => {
        const plan = planSections([10, 20, 100], [true, false, false], 48);
        expect(plan).toEqual([
            { rows: 0, showHeader: true },
            { rows: 20, showHeader: true },
            { rows: 28, showHeader: true },
        ]);
    });

    it('a collapsed group below rows not yet mounted waits (no header jumping above the spacer)', () => {
        const plan = planSections([10, 100, 30], [false, false, true], 48);
        expect(plan[2]).toEqual({ rows: 0, showHeader: false });
        // once the budget reaches it, its header appears
        expect(planSections([10, 100, 30], [false, false, true], 110)[2]).toEqual({ rows: 0, showHeader: true });
    });

    it('an empty group never shows, collapsed or not', () => {
        expect(planSections([0, 5], [true, false], 48)[0]).toEqual({ rows: 0, showHeader: false });
        expect(planSections([0, 5], [false, false], 48)[0]).toEqual({ rows: 0, showHeader: false });
    });

    it('expandedRowTotal skips collapsed groups', () => {
        expect(expandedRowTotal([10, 20, 100], [false, true, false])).toBe(110);
        expect(expandedRowTotal([10, 20, 100], [true, true, true])).toBe(0);
    });
});
