/**
 * Pure rules behind the member role picker (MemberRolePicker / RolePickerList)
 * and the Server Settings role list's search box.
 *
 * ── Permission mirror ───────────────────────────────────────────────────────
 * The SERVER is authoritative: `RolesService.assignRole` / `unassignRole`
 * (apps/api/src/servers/roles.service.ts) require MANAGE_ROLES via
 * `requireServerPermission` (ADMINISTRATOR resolves to every bit) and reject a
 * role whose `position` is at or above the actor's highest role
 * (`highestPositionFor`: the owner is +Infinity, an actor with no roles is -1,
 * otherwise the max position over the actor's ASSIGNED roles — @everyone is
 * never assigned, so it never counts). @everyone itself can never be assigned.
 *
 * Everything here only mirrors those rules so the UI does not offer a toggle
 * the server will refuse. It decides nothing: a stale or tampered client still
 * gets a 403 from the API.
 */
import { foldForMatch } from '../../../utils/mentionSuggestions';
import { Permissions, hasPermission } from '@cipherline/shared';

/** Above this many rows the picker / role list grows a search box. */
export const ROLE_SEARCH_THRESHOLD = 10;

/** Width of the in-menu "Roles ▸" flyout (MemberRolesFlyout), px. */
export const ROLES_FLYOUT_WIDTH = 240;
/**
 * Height the flyout spends on things other than the scrolling rows: its own
 * padding + border, the search box (over 10 roles) and the "N roles above
 * yours" footer.
 */
const FLYOUT_CHROME_PX = 92;

/** The flyout's rows get what is left of its height cap, between 96 and 320 px. */
export function flyoutListHeight(maxHeight: number): number {
    return Math.max(96, Math.min(320, maxHeight - FLYOUT_CHROME_PX));
}

export interface PickerRole {
    role_id: string;
    name: string;
    color: number;
    position: number;
    is_everyone: boolean;
}

export interface PickerMember {
    user_id: string;
    role_ids: string[];
}

/** "If they have more than 10 roles ... make a search bar appear." */
export function shouldShowRoleSearch(rowCount: number): boolean {
    return rowCount > ROLE_SEARCH_THRESHOLD;
}

/** Case-insensitive substring match on the role name. Blank query = everything. */
export function filterRolesByQuery<T extends { name: string }>(roles: readonly T[], query: string): T[] {
    // Folded on both sides so plain typing finds decorative names ("aes" finds 𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬).
    const q = foldForMatch(query).trim();
    if (!q) return [...roles];
    return roles.filter(r => foldForMatch(r.name).includes(q));
}

/** MANAGE_ROLES or ADMINISTRATOR — the same bits `requireServerPermission` accepts. */
export function hasManageRolesPermission(perms: bigint | null | undefined): boolean {
    if (!perms) return false;
    return hasPermission(perms, Permissions.MANAGE_ROLES) || hasPermission(perms, Permissions.ADMINISTRATOR);
}

/** Mirror of `RolesService.highestPositionFor`. */
export function actorHighestPosition(
    actorUserId: string | null | undefined,
    ownerUserId: string | null | undefined,
    members: readonly PickerMember[],
    roles: readonly PickerRole[],
): number {
    if (!actorUserId) return -1;
    if (ownerUserId && ownerUserId.toLowerCase() === actorUserId.toLowerCase()) return Number.POSITIVE_INFINITY;
    const me = members.find(m => m.user_id === actorUserId);
    if (!me || me.role_ids.length === 0) return -1;
    const mine = new Set(me.role_ids);
    return roles.reduce((max, r) => (mine.has(r.role_id) && !r.is_everyone ? Math.max(max, r.position) : max), -1);
}

/** The server accepts a toggle of this role from an actor whose highest role is `actorHighest`. */
export function canToggleRole(role: PickerRole, actorHighest: number): boolean {
    return !role.is_everyone && actorHighest > role.position;
}

/**
 * The roles the picker offers, highest first, plus how many real (non-@everyone)
 * roles were left out because they sit at or above the actor.
 */
export function assignableRoles<T extends PickerRole>(
    roles: readonly T[],
    actorHighest: number,
): { roles: T[]; hiddenAbove: number } {
    const real = roles.filter(r => !r.is_everyone);
    const ok = real.filter(r => canToggleRole(r, actorHighest)).sort((a, b) => b.position - a.position);
    return { roles: ok, hiddenAbove: real.length - ok.length };
}

/**
 * Whether to offer a "Roles" entry / "+" button at all: the permission bit,
 * and — once the roster is known — at least one role the actor can toggle.
 * Before the roster has loaded the entry is offered on the permission alone;
 * the picker then loads it and says so if nothing is assignable.
 */
export function canOfferRolePicker(args: {
    perms: bigint | null | undefined;
    actorUserId: string | null | undefined;
    ownerUserId: string | null | undefined;
    roster: { members: readonly PickerMember[]; roles: readonly PickerRole[] } | null;
}): boolean {
    if (!hasManageRolesPermission(args.perms)) return false;
    if (!args.roster) return true;
    const highest = actorHighestPosition(args.actorUserId, args.ownerUserId, args.roster.members, args.roster.roles);
    return assignableRoles(args.roster.roles, highest).roles.length > 0;
}

/** `ids` with `roleId` present (assign) or absent (unassign), order preserved. */
export function withRole(ids: readonly string[], roleId: string, assigned: boolean): string[] {
    const has = ids.includes(roleId);
    if (assigned) return has ? [...ids] : [...ids, roleId];
    return has ? ids.filter(id => id !== roleId) : [...ids];
}
