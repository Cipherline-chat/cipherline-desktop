/**
 * Collapsible member-list groups (server panel: hoisted role groups, Online,
 * Offline) — the pure half. The React half
 * is hooks/useCollapsedGroups.ts.
 *
 * Storage (secureLocalStore, classified in services/backupRegistry.ts):
 *   cipherline_member_groups_collapsed_<uid>_<serverId>  JSON array of group ids
 *
 * Group ids are stable across renames: a role group is keyed by its role_id,
 * so renaming "Mods" to "Moderators" keeps it collapsed. A role that is
 * deleted (or stops being "display separately") leaves a stale id behind;
 * pruneCollapsed drops it the next time the roster is loaded, so the stored
 * list can never grow past the server's current hoisted roles + 2.
 */

export const MEMBER_GROUPS_COLLAPSED_PREFIX = 'cipherline_member_groups_collapsed_';

export const memberGroupsCollapsedKey = (userId: string, serverId: string): string =>
    `${MEMBER_GROUPS_COLLAPSED_PREFIX}${userId}_${serverId}`;

export const ONLINE_GROUP_ID = 'online';
export const OFFLINE_GROUP_ID = 'offline';
export const roleGroupId = (roleId: string): string => `role:${roleId}`;

/** Hard ceiling on what a stored list may hold, so a corrupt or hostile
 *  record (restored from a backup) can't make every render walk a huge array. */
export const MAX_STORED_GROUP_IDS = 512;

/** Stored value → set of collapsed ids. Anything that is not an array of
 *  short strings reads as "nothing collapsed" (never throws). */
export function parseCollapsed(raw: string | null | undefined): Set<string> {
    if (!raw) return new Set();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return new Set(); }
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const v of parsed) {
        if (typeof v !== 'string' || v.length === 0 || v.length > 128) continue;
        out.add(v);
        if (out.size >= MAX_STORED_GROUP_IDS) break;
    }
    return out;
}

/** Set → stored value (sorted, so the same set always writes the same bytes). */
export function serializeCollapsed(ids: ReadonlySet<string>): string {
    return JSON.stringify([...ids].sort());
}

export function toggleCollapsed(ids: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(ids);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
}

/** Drop ids not in `valid`. Returns the SAME instance when nothing was
 *  dropped, so callers can skip a write with a reference check. */
export function pruneCollapsed<T extends ReadonlySet<string>>(ids: T, valid: ReadonlySet<string>): T | Set<string> {
    let stale = false;
    for (const id of ids) if (!valid.has(id)) { stale = true; break; }
    if (!stale) return ids;
    const next = new Set<string>();
    for (const id of ids) if (valid.has(id)) next.add(id);
    return next;
}

export interface GroupableRole {
    role_id: string;
    hoisted?: boolean;
    is_everyone?: boolean;
}

/** Every group id the server's member list can show right now: Online,
 *  Offline, and one per hoisted ("display separately") role. A role with no
 *  one online is still valid — its group comes back when someone is. */
export function validMemberGroupIds(roles: ReadonlyArray<GroupableRole>): Set<string> {
    const out = new Set<string>([ONLINE_GROUP_ID, OFFLINE_GROUP_ID]);
    for (const r of roles) if (r.hoisted && !r.is_everyone) out.add(roleGroupId(r.role_id));
    return out;
}

export interface SectionPlan {
    /** Rows to mount for this section (0 when collapsed or past the budget). */
    rows: number;
    /** Render the section's header at all. */
    showHeader: boolean;
}

/**
 * Row budgeting (utils/incrementalRows) that knows about collapsed sections.
 * A collapsed section costs no budget, and its header still shows as long as
 * every section above it is fully mounted — otherwise a collapsed "Offline"
 * at the bottom of a long list would pop in above rows still to be mounted.
 * An empty section (`counts[i] === 0`) never shows, collapsed or not.
 */
export function planSections(
    counts: ReadonlyArray<number>,
    collapsed: ReadonlyArray<boolean>,
    budget: number,
): SectionPlan[] {
    let left = Math.max(0, budget);
    let allAboveMounted = true;
    return counts.map((raw, i) => {
        const n = Math.max(0, raw);
        if (n === 0) return { rows: 0, showHeader: false };
        if (collapsed[i]) return { rows: 0, showHeader: allAboveMounted };
        const rows = Math.min(n, left);
        left -= rows;
        const plan = { rows, showHeader: rows > 0 };
        if (rows < n) allAboveMounted = false;
        return plan;
    });
}

/** Rows a list would mount if nothing were budgeted: collapsed sections count 0. */
export function expandedRowTotal(counts: ReadonlyArray<number>, collapsed: ReadonlyArray<boolean>): number {
    let total = 0;
    counts.forEach((n, i) => { if (!collapsed[i]) total += Math.max(0, n); });
    return total;
}
