import type { RosterRole } from '../../../utils/serverRosterCache';

/**
 * A member's assigned roles for a compact chip row: highest position first,
 * @everyone never listed, at most `max` shown with the rest counted.
 * Pure, so the Server Settings members tab stays a thin view over the roster.
 */
export function memberRoleChips(
    roles: ReadonlyArray<RosterRole> | null | undefined,
    roleIds: readonly string[] | null | undefined,
    max: number,
): { shown: RosterRole[]; more: number } {
    if (!roles || !roleIds || roleIds.length === 0) return { shown: [], more: 0 };
    const ids = new Set(roleIds);
    const held = roles
        .filter(r => ids.has(r.role_id) && !r.is_everyone)
        .sort((a, b) => b.position - a.position);
    const n = Math.max(0, max);
    return { shown: held.slice(0, n), more: Math.max(0, held.length - n) };
}
