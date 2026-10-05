import { describe, it, expect } from 'vitest';
import {
    membersEqual,
    reconcileMembers,
    assignRoleLocally,
    unassignRoleLocally,
    partitionByRole,
    pruneSelection,
    type ServerMember,
} from './roleMemberState';

/**
 * These pin the state-reconciliation half of the "adding/removing a member
 * from a role scrolls the settings pane back to the top" fix. The scroll
 * behaviour itself is not testable here (no layout), so the invariants that
 * PRODUCE it are tested instead:
 *
 *   • an echo refresh that carries no real change must return the PREVIOUS
 *     array by identity, so `setMembers` hits React's bail-out and the list
 *     never re-renders (and therefore never changes height);
 *   • an unchanged member inside a changed list must keep its object identity,
 *     so its row is reconciled rather than torn down and rebuilt;
 *   • the optimistic edits must be exact inverses, so a failed mutation can be
 *     reverted precisely instead of triggering a refetch.
 */

function m(user_id: string, role_ids: string[] = [], over: Partial<ServerMember> = {}): ServerMember {
    return {
        user_id,
        username: user_id,
        discriminator: 1,
        nickname: null,
        avatar_url: null,
        role_ids,
        ...over,
    };
}

const ROLE = 'r-mods';

describe('membersEqual', () => {
    it('treats role_ids as a set, not a sequence', () => {
        expect(membersEqual(m('u1', ['a', 'b']), m('u1', ['b', 'a']))).toBe(true);
    });

    it('is false when a role is genuinely added', () => {
        expect(membersEqual(m('u1', ['a']), m('u1', ['a', 'b']))).toBe(false);
    });

    it('is false when a role is swapped for a different one of the same count', () => {
        // Guards the length-only shortcut: same size, different contents.
        expect(membersEqual(m('u1', ['a', 'b']), m('u1', ['a', 'c']))).toBe(false);
    });

    it('notices profile field changes', () => {
        expect(membersEqual(m('u1'), m('u1', [], { nickname: 'Al' }))).toBe(false);
        expect(membersEqual(m('u1'), m('u1', [], { avatar_url: 'att1' }))).toBe(false);
        expect(membersEqual(m('u1'), m('u1', [], { username: 'other' }))).toBe(false);
        expect(membersEqual(m('u1'), m('u1', [], { discriminator: 2 }))).toBe(false);
    });
});

describe('reconcileMembers', () => {
    it('returns the PREVIOUS array by identity when the refresh carries no change', () => {
        // This is the property that makes the post-mutation echo render nothing.
        const prev = [m('u1', [ROLE]), m('u2')];
        const incoming = [m('u1', [ROLE]), m('u2')]; // fresh objects, same data
        const out = reconcileMembers(prev, incoming);
        expect(out).toBe(prev);
    });

    it('POSITIVE CONTROL: a real change does produce a new array', () => {
        // Without this the test above would also pass on a function that
        // always returned `prev`.
        const prev = [m('u1', [ROLE]), m('u2')];
        const incoming = [m('u1', [ROLE]), m('u2', [ROLE])];
        const out = reconcileMembers(prev, incoming);
        expect(out).not.toBe(prev);
        expect(out[1].role_ids).toEqual([ROLE]);
    });

    it('keeps the identity of members that did not change, inside a list that did', () => {
        const u1 = m('u1', [ROLE]);
        const u2 = m('u2');
        const prev = [u1, u2];
        const incoming = [m('u1', [ROLE]), m('u2', [ROLE])];
        const out = reconcileMembers(prev, incoming);
        expect(out[0]).toBe(u1);       // untouched row is reused, not rebuilt
        expect(out[1]).not.toBe(u2);   // genuinely changed row is replaced
    });

    it('adopts the incoming membership when someone joins or leaves', () => {
        const prev = [m('u1'), m('u2')];
        expect(reconcileMembers(prev, [m('u1'), m('u2'), m('u3')]).map(x => x.user_id))
            .toEqual(['u1', 'u2', 'u3']);
        expect(reconcileMembers(prev, [m('u1')]).map(x => x.user_id)).toEqual(['u1']);
    });

    it('detects a pure REORDER even though every member is individually unchanged', () => {
        // Same people, same data, different order. Returning `prev` here would
        // silently ignore a server-side ordering change.
        const prev = [m('u1'), m('u2')];
        const out = reconcileMembers(prev, [m('u2'), m('u1')]);
        expect(out).not.toBe(prev);
        expect(out.map(x => x.user_id)).toEqual(['u2', 'u1']);
    });

    it('handles the first load, where prev is empty', () => {
        const incoming = [m('u1')];
        expect(reconcileMembers([], incoming)).toEqual(incoming);
    });

    it('handles an empty server without returning a stale list', () => {
        expect(reconcileMembers([m('u1')], [])).toEqual([]);
    });

    it('does not mutate either input', () => {
        const prev = [m('u1', [ROLE])];
        const incoming = [m('u1', [ROLE, 'other'])];
        const prevSnapshot = JSON.stringify(prev);
        const incomingSnapshot = JSON.stringify(incoming);
        reconcileMembers(prev, incoming);
        expect(JSON.stringify(prev)).toBe(prevSnapshot);
        expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
    });
});

describe('assignRoleLocally / unassignRoleLocally', () => {
    it('grants the role to exactly the named members', () => {
        const out = assignRoleLocally([m('u1'), m('u2'), m('u3')], ['u1', 'u3'], ROLE);
        expect(out.map(x => x.role_ids)).toEqual([[ROLE], [], [ROLE]]);
    });

    it('revokes the role from exactly the named members', () => {
        const start = [m('u1', [ROLE]), m('u2', [ROLE]), m('u3', [ROLE])];
        const out = unassignRoleLocally(start, ['u2'], ROLE);
        expect(out.map(x => x.role_ids)).toEqual([[ROLE], [], [ROLE]]);
    });

    it('preserves unrelated roles on both paths', () => {
        const start = [m('u1', ['keep-me'])];
        const granted = assignRoleLocally(start, ['u1'], ROLE);
        expect(granted[0].role_ids).toEqual(['keep-me', ROLE]);
        expect(unassignRoleLocally(granted, ['u1'], ROLE)[0].role_ids).toEqual(['keep-me']);
    });

    it('are exact inverses — the revert path restores the original state', () => {
        // This is what a failed mutation relies on instead of a refetch.
        const start = [m('u1', ['a']), m('u2', []), m('u3', [ROLE])];
        const optimistic = assignRoleLocally(start, ['u1', 'u2'], ROLE);
        const reverted = unassignRoleLocally(optimistic, ['u1', 'u2'], ROLE);
        expect(reverted).toEqual(start);
    });

    it('is idempotent and identity-stable when the role is already correct', () => {
        const start = [m('u1', [ROLE])];
        expect(assignRoleLocally(start, ['u1'], ROLE)).toBe(start);
        const none = [m('u1', [])];
        expect(unassignRoleLocally(none, ['u1'], ROLE)).toBe(none);
    });

    it('returns the input untouched for an empty target set', () => {
        const start = [m('u1')];
        expect(assignRoleLocally(start, [], ROLE)).toBe(start);
        expect(unassignRoleLocally(start, [], ROLE)).toBe(start);
    });

    it('ignores user ids that are not in the roster', () => {
        const start = [m('u1')];
        expect(assignRoleLocally(start, ['ghost'], ROLE)).toBe(start);
    });

    it('accepts a Set as well as an array (the selection state is a Set)', () => {
        const out = assignRoleLocally([m('u1'), m('u2')], new Set(['u2']), ROLE);
        expect(out.map(x => x.role_ids)).toEqual([[], [ROLE]]);
    });

    it('does not mutate the members it leaves alone', () => {
        const u2 = m('u2');
        const out = assignRoleLocally([m('u1'), u2], ['u1'], ROLE);
        expect(out[1]).toBe(u2);
    });
});

describe('partitionByRole', () => {
    const roster = [
        m('u1', [ROLE], { username: 'alice', nickname: 'Ali' }),
        m('u2', [], { username: 'bob' }),
        m('u3', [], { username: 'carol', nickname: 'Caz' }),
    ];

    it('splits holders from non-holders', () => {
        const { withRole, withoutRole } = partitionByRole(roster, ROLE, '');
        expect(withRole.map(x => x.user_id)).toEqual(['u1']);
        expect(withoutRole.map(x => x.user_id)).toEqual(['u2', 'u3']);
    });

    it('applies the search to non-holders only, never to the current members list', () => {
        // Filtering the "Members with this role" list by the add-box search
        // would make rows vanish while typing — a different kind of jump.
        const { withRole, withoutRole } = partitionByRole(roster, ROLE, 'bob');
        expect(withRole.map(x => x.user_id)).toEqual(['u1']);
        expect(withoutRole.map(x => x.user_id)).toEqual(['u2']);
    });

    it('matches on nickname as well as username, case-insensitively', () => {
        expect(partitionByRole(roster, ROLE, 'CAZ').withoutRole.map(x => x.user_id)).toEqual(['u3']);
        expect(partitionByRole(roster, ROLE, 'CaRo').withoutRole.map(x => x.user_id)).toEqual(['u3']);
    });

    it('treats a whitespace-only search as no search', () => {
        expect(partitionByRole(roster, ROLE, '   ').withoutRole).toHaveLength(2);
    });

    it('returns an empty non-holder list when nothing matches', () => {
        expect(partitionByRole(roster, ROLE, 'zzz').withoutRole).toEqual([]);
    });
});

describe('pruneSelection', () => {
    it('drops the ids that succeeded and keeps the ones that failed', () => {
        const out = pruneSelection(new Set(['u1', 'u2', 'u3']), ['u1', 'u3']);
        expect([...out].sort()).toEqual(['u2']);
    });

    it('returns the same Set by identity when nothing was removed', () => {
        const sel = new Set(['u1']);
        expect(pruneSelection(sel, ['ghost'])).toBe(sel);
        expect(pruneSelection(sel, [])).toBe(sel);
    });

    it('does not mutate the input Set', () => {
        const sel = new Set(['u1', 'u2']);
        pruneSelection(sel, ['u1']);
        expect([...sel].sort()).toEqual(['u1', 'u2']);
    });
});
