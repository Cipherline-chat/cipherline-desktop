/**
 * roleMemberState — the pure state logic behind the "Manage Members" section
 * of the role editor (`RoleMembersEditor`).
 *
 * This is isolated here for the same reason `roleReorderMath` is: it is the
 * part that can be tested deterministically. The scroll behaviour it exists to
 * protect cannot be, so the invariant has to be pinned one level down.
 *
 * WHY THIS MODULE EXISTS — the bug it was extracted to fix
 * ────────────────────────────────────────────────────────
 * Adding or removing a member from a role made the whole settings pane flash
 * and scroll back to the top. The mutation itself was never the problem: it
 * already applied its change locally and did not refetch. The reset came from
 * the server ECHOING the mutation back to the person who made it —
 * `assignRole`/`unassignRole` call `fanOutPermissionsChange`, which emits
 * `server:permissions_changed` to EVERY member of the server, the actor
 * included. `Dashboard` reacts to that by bumping its own state, which
 * re-renders `ServerSettingsModal` → `RolesTabContainer` → a brand-new inline
 * `onError` closure → `RoleMembersEditor`'s `load` callback changed identity →
 * its fetch effect refired → `setLoading(true)` → the ENTIRE members section
 * was replaced by a 20px spinner. Collapsing several hundred pixels out of the
 * bottom of a scroll container makes the browser clamp `scrollTop`, which is
 * the "brings you up to the top" the report describes; the list reappearing a
 * round-trip later is the flash.
 *
 * So there are two defences, and both live here rather than in the component:
 *
 *  1. `reconcileMembers` — a refresh MERGES into the list that is already on
 *     screen instead of replacing it. It returns the PREVIOUS array when
 *     nothing changed (so `setMembers` hits React's bail-out and renders
 *     nothing at all), and reuses the previous object for every individual
 *     member that is unchanged, so unchanged rows keep their identity and are
 *     never torn down and rebuilt. A row rebuild would remount
 *     `EncryptedAvatar` and re-download the avatar, which is its own flash.
 *
 *  2. `assignRoleLocally` / `unassignRoleLocally` — the optimistic edits, and
 *     their exact inverses, so a failed mutation can be reverted precisely
 *     rather than papered over with a refetch.
 *
 * Every function here is pure and never mutates its input.
 */

export interface ServerMember {
    user_id: string;
    username: string;
    discriminator: string | number;
    nickname: string | null;
    avatar_url: string | null;
    role_ids: string[];
}

/** Field-by-field equality for one member. `role_ids` is compared as a SET —
 *  the server does not promise an order, so a reordered-but-identical array
 *  must not read as a change and churn the row. */
export function membersEqual(a: ServerMember, b: ServerMember): boolean {
    if (a === b) return true;
    if (
        a.user_id !== b.user_id ||
        a.username !== b.username ||
        a.discriminator !== b.discriminator ||
        a.nickname !== b.nickname ||
        a.avatar_url !== b.avatar_url ||
        a.role_ids.length !== b.role_ids.length
    ) return false;
    const seen = new Set(a.role_ids);
    return b.role_ids.every(r => seen.has(r));
}

/**
 * Merge a freshly-fetched member list into the one already rendered.
 *
 * Takes the incoming list as authoritative for membership and order, but
 * preserves object identity wherever the data is unchanged:
 *   • returns `prev` itself when the two lists are equivalent, so the caller's
 *     `setMembers` is a no-op and React re-renders nothing;
 *   • otherwise returns a new array in the INCOMING order, reusing each
 *     previous member object whose fields are unchanged.
 */
export function reconcileMembers(prev: ServerMember[], incoming: ServerMember[]): ServerMember[] {
    const byId = new Map(prev.map(m => [m.user_id, m]));

    let changed = prev.length !== incoming.length;
    const merged = incoming.map((next, i) => {
        const old = byId.get(next.user_id);
        if (old && membersEqual(old, next)) {
            // Same data — keep the old reference. Also detect a pure REORDER:
            // the data is unchanged but the position is not.
            if (prev[i] !== old) changed = true;
            return old;
        }
        changed = true;
        return next;
    });

    return changed ? merged : prev;
}

/** Grant `roleId` to every member in `userIds`. Members who already hold it,
 *  and members not named, are returned by identity (no churn). */
export function assignRoleLocally(
    members: ServerMember[],
    userIds: Iterable<string>,
    roleId: string,
): ServerMember[] {
    const targets = userIds instanceof Set ? userIds : new Set(userIds);
    if (targets.size === 0) return members;
    let changed = false;
    const next = members.map(m => {
        if (!targets.has(m.user_id) || m.role_ids.includes(roleId)) return m;
        changed = true;
        return { ...m, role_ids: [...m.role_ids, roleId] };
    });
    return changed ? next : members;
}

/** Revoke `roleId` from every member in `userIds`. The exact inverse of
 *  `assignRoleLocally`, which is what makes a failed mutation revertible. */
export function unassignRoleLocally(
    members: ServerMember[],
    userIds: Iterable<string>,
    roleId: string,
): ServerMember[] {
    const targets = userIds instanceof Set ? userIds : new Set(userIds);
    if (targets.size === 0) return members;
    let changed = false;
    const next = members.map(m => {
        if (!targets.has(m.user_id) || !m.role_ids.includes(roleId)) return m;
        changed = true;
        return { ...m, role_ids: m.role_ids.filter(r => r !== roleId) };
    });
    return changed ? next : members;
}

/** Split the roster into holders and non-holders of `roleId`, applying the
 *  "add members" search box to the non-holders only. */
export function partitionByRole(
    members: ServerMember[],
    roleId: string,
    search: string,
): { withRole: ServerMember[]; withoutRole: ServerMember[] } {
    const q = search.trim().toLowerCase();
    const withRole: ServerMember[] = [];
    const withoutRole: ServerMember[] = [];
    for (const m of members) {
        if (m.role_ids.includes(roleId)) {
            withRole.push(m);
        } else if (
            !q ||
            (m.nickname ?? '').toLowerCase().includes(q) ||
            m.username.toLowerCase().includes(q)
        ) {
            withoutRole.push(m);
        }
    }
    return { withRole, withoutRole };
}

/** Drop every id in `remove` from `selected`, returning `selected` untouched
 *  when nothing matched (so a no-op bulk result does not re-render). */
export function pruneSelection(selected: Set<string>, remove: Iterable<string>): Set<string> {
    const next = new Set(selected);
    let changed = false;
    for (const id of remove) {
        if (next.delete(id)) changed = true;
    }
    return changed ? next : selected;
}
