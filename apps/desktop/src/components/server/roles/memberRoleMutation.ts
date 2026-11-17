/**
 * Assign / unassign one server role on one member, optimistically, from any
 * surface (member-list menu, chat message menu, profile card).
 *
 * The roster (utils/serverRosterCache) is the source of truth for who holds
 * which role. While a toggle is in flight the member's role ids are OVERRIDDEN
 * here, so every surface that reads `useMemberRoleIds` — the picker's
 * checkboxes, the profile card's chips — flips on the click instead of a
 * round trip later. When the last in-flight toggle for that member settles,
 * the roster is force-refreshed and the override is dropped, so what remains
 * on screen is what the server actually stored.
 *
 * A failed toggle rolls back ONLY its own role (another toggle on the same
 * member may still be in flight) and rethrows so the caller can toast.
 *
 * The API (PUT / DELETE /v1/servers/:sid/members/:uid/roles/:rid) enforces
 * MANAGE_ROLES and the role hierarchy; see rolePickerModel.ts.
 */
import axios from 'axios';
import { useSyncExternalStore } from 'react';
import { apiUrl } from '../../../utils/apiPath';
import { getRoster, refreshRoster } from '../../../utils/serverRosterCache';
import { useServerRoster } from '../../../hooks/useServerRoster';
import { withRole } from './rolePickerModel';

const overrides = new Map<string, readonly string[]>();
const inflight = new Map<string, number>();
const listeners = new Set<() => void>();

const keyOf = (serverId: string, userId: string) => `${serverId}\u0000${userId}`;

function emit(): void {
    for (const l of Array.from(listeners)) l();
}

export function subscribeRoleOverrides(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getRoleOverride(serverId: string | null | undefined, userId: string | null | undefined): readonly string[] | undefined {
    if (!serverId || !userId) return undefined;
    return overrides.get(keyOf(serverId, userId));
}

/** The member's role ids from the cached roster, or undefined when not cached / not a member. */
export function rosterRoleIds(serverId: string, userId: string): readonly string[] | undefined {
    return getRoster(serverId)?.members.find(m => m.user_id === userId)?.role_ids;
}

/** Test hook. */
export function isRoleToggleInFlight(serverId: string, userId: string): boolean {
    return (inflight.get(keyOf(serverId, userId)) ?? 0) > 0;
}

export interface SetMemberRoleArgs {
    serverId: string;
    userId: string;
    roleId: string;
    /** true = assign, false = unassign. */
    assign: boolean;
    token: string;
    /** Role ids to start from when neither an override nor the roster has the member (a lazily-fetched profile). */
    fallbackIds?: readonly string[];
}

export async function setMemberRole(args: SetMemberRoleArgs): Promise<void> {
    const { serverId, userId, roleId, assign, token } = args;
    const k = keyOf(serverId, userId);
    const base = () => overrides.get(k) ?? rosterRoleIds(serverId, userId) ?? args.fallbackIds ?? [];

    overrides.set(k, withRole(base(), roleId, assign));
    inflight.set(k, (inflight.get(k) ?? 0) + 1);
    emit();

    const headers = { Authorization: `Bearer ${token}` };
    let failure: unknown = null;
    try {
        if (assign) {
            await axios.put(apiUrl`/servers/${serverId}/members/${userId}/roles/${roleId}`, {}, { headers });
        } else {
            await axios.delete(apiUrl`/servers/${serverId}/members/${userId}/roles/${roleId}`, { headers });
        }
    } catch (err) {
        failure = err;
        // Roll back this role only — a sibling toggle may still be pending.
        overrides.set(k, withRole(base(), roleId, !assign));
        emit();
    }

    const left = (inflight.get(k) ?? 1) - 1;
    if (left > 0) {
        inflight.set(k, left);
    } else {
        inflight.delete(k);
        // Pull what the server stored, THEN drop the override, so the checkbox
        // never flickers back to the pre-click state in between.
        try { await refreshRoster(serverId, token, { force: true }); } catch { /* the override still goes; the next roster event corrects it */ }
        if (!inflight.has(k)) {
            overrides.delete(k);
            emit();
        }
    }
    if (failure) throw failure;
}

/** Message for a failed toggle — the server's own reason when it gave one. */
export function roleToggleErrorMessage(err: unknown): string {
    const data = (err as { response?: { data?: { message?: unknown }; status?: number } })?.response;
    const msg = data?.data?.message;
    if (typeof msg === 'string' && msg.trim()) return msg;
    if (Array.isArray(msg) && typeof msg[0] === 'string') return msg[0];
    if (data?.status === 403) return 'You can only change roles below your highest role.';
    if (data?.status === 429) return 'Too many role changes at once. Try again in a few seconds.';
    return 'Could not update roles. Check your connection and try again.';
}

/**
 * The member's role ids as every surface should show them: an in-flight
 * override, else the cached roster, else `fallback` (e.g. ids the caller
 * fetched itself), else undefined.
 */
export function useMemberRoleIds(
    serverId: string | null | undefined,
    userId: string | null | undefined,
    fallback?: readonly string[],
): readonly string[] | undefined {
    const roster = useServerRoster(serverId ?? null);
    const override = useSyncExternalStore(
        subscribeRoleOverrides,
        () => getRoleOverride(serverId, userId),
        () => undefined,
    );
    if (override) return override;
    const fromRoster = userId ? roster?.members.find(m => m.user_id === userId)?.role_ids : undefined;
    return fromRoster ?? fallback;
}

/** Tests only. */
export function __resetRoleOverrides(): void {
    overrides.clear();
    inflight.clear();
    listeners.clear();
}
