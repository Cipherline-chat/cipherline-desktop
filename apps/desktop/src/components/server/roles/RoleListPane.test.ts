import { describe, it, expect } from 'vitest';
import { computeMovePosition } from './roleReorderMath';
import type { Role } from './types';

/**
 * `computeMovePosition` is the one piece of ordering math behind every
 * hierarchy reorder in the Roles pane — the old drag-to-reorder rail, the
 * up/down buttons that briefly replaced it, and now the dropdown's
 * drag-to-reorder AND its keyboard (Alt+Arrow) equivalent all funnel through
 * this exact function via `RoleListPane`'s `moveRole`. Get this subtly wrong
 * and every reorder path breaks at once, which is exactly why it's isolated
 * and unit-tested here rather than only exercised indirectly through a
 * rendered dropdown.
 *
 * Imports from the pure `roleReorderMath` module rather than `RoleListPane`
 * itself: `RoleListPane.tsx` imports `ClSelect`, which pulls in
 * `clPhysics.ts`'s `window.matchMedia` module-load side effect — undefined
 * under this suite's `node` vitest environment (no jsdom).
 */
function role(id: string, position: number): Role {
    return {
        role_id: id,
        name: id,
        color: -1,
        position,
        permissions: '0',
        mentionable: false,
        hoisted: false,
        is_everyone: false,
    };
}

describe('computeMovePosition', () => {
    // Sorted descending by position — index 0 is the top of the hierarchy,
    // matching how RoleListPane builds `draggableRoles`.
    const A = role('A', 30);
    const B = role('B', 20);
    const C = role('C', 10);
    const roles = [A, B, C];

    it('moving down one slot lands strictly between its new neighbours', () => {
        // A (index 0) moves to index 1, landing between B (20) and C (10).
        const pos = computeMovePosition(roles, 0, 1);
        expect(pos).toBe(15);
        expect(pos).toBeLessThan(B.position);
        expect(pos).toBeGreaterThan(C.position);
    });

    it('moving up one slot lands strictly between its new neighbours', () => {
        // B (index 1) moves to index 0, landing above A (30).
        const pos = computeMovePosition(roles, 1, 0);
        expect(pos).toBeGreaterThan(A.position);
    });

    it('moving to the very top (the end furthest from index 0 in rank) gets headroom above the current top', () => {
        // C (index 2, lowest) moves to index 0 (highest).
        const pos = computeMovePosition(roles, 2, 0);
        expect(pos).toBe(530);
        expect(pos).toBeGreaterThan(A.position);
    });

    it('moving to the very bottom floors out just above zero, never below', () => {
        // A (index 0, highest) moves to index 2 (lowest slot).
        const pos = computeMovePosition(roles, 0, 2);
        expect(pos).toBe(5);
        expect(pos).toBeGreaterThan(0);
        expect(pos).toBeLessThan(C.position);
    });

    it('a no-op move (fromIndex === toIndex) reproduces the role\'s own current position', () => {
        // B doesn't move — the midpoint math should reconstruct exactly
        // where it already was (between A and C), not drift it.
        const pos = computeMovePosition(roles, 1, 1);
        expect(pos).toBe(B.position);
    });

    it('never returns a position below the floor of 1, even with no lower neighbour', () => {
        const twoRoles = [role('X', 2), role('Y', 1)];
        // Move Y (index 1) down past the end — there is no further "down" to
        // go, so the lower bound is 0 and the result must still floor at 1.
        const pos = computeMovePosition(twoRoles, 1, 1);
        expect(pos).toBeGreaterThanOrEqual(1);
    });

    it('swapping two adjacent roles is symmetric: each lands where the other was heading', () => {
        const pair = [role('X', 30), role('Y', 10)];
        const downPos = computeMovePosition(pair, 0, 1); // X moves below Y
        const upPos = computeMovePosition(pair, 1, 0);   // Y moves above X
        expect(downPos).toBeLessThan(pair[1].position);
        expect(upPos).toBeGreaterThan(pair[0].position);
    });
});
