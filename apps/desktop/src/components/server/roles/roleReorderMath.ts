import type { Role } from './types';

/**
 * Pure ordering math behind every hierarchy reorder in the Roles pane — the
 * old drag-to-reorder rail, the up/down buttons that briefly replaced it, and
 * now the roles dropdown's own drag-to-reorder (+ keyboard equivalent), all
 * funnel through this one function via `RoleListPane`'s `moveRole`.
 *
 * Split into its own dependency-free module — same pattern as `ClSelect`'s
 * `reorderMath.ts` — so it's testable from a plain `.test.ts` file without
 * dragging in `RoleListPane.tsx`'s import of `ClSelect` (which pulls in
 * `clPhysics.ts`'s `window.matchMedia` module-load side effect, undefined
 * under this suite's `node` vitest environment).
 *
 * Places the moved role's `position` halfway between its new neighbours (or
 * +1000 / 0 past an end) so a single move never requires renumbering the
 * rest.
 */
export function computeMovePosition(draggableRoles: Role[], fromIndex: number, toIndex: number): number {
    const newOrder = draggableRoles.slice();
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, moved);

    const upperPos = toIndex > 0
        ? newOrder[toIndex - 1].position
        : (newOrder[1]?.position ?? 0) + 1000;
    const lowerPos = toIndex < newOrder.length - 1
        ? newOrder[toIndex + 1].position
        : 0;
    return Math.max(1, Math.floor((upperPos + lowerPos) / 2));
}
