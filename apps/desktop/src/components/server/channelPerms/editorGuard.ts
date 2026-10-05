/**
 * What the CURRENT user may change in a channel / category override editor.
 *
 * UI gating only — the server is the authority. This mirrors exactly what
 * `apps/api/src/servers/override-guard.service.ts` enforces on every
 * override write (and refuses with a 403 the save path maps to a message):
 *
 *  - Owner / ADMINISTRATOR: nothing is gated.
 *  - SCOPE: the actor needs VIEW_CHANNEL and MANAGE_CHANNELS as resolved IN
 *    the edited channel / category. Without them nothing here is editable.
 *  - HIERARCHY: a role override only for a role STRICTLY below the actor's
 *    highest role (@everyone is always below); a member override only for a
 *    member whose highest role is strictly below theirs and who is not the
 *    owner. Their own member override is editable, within the diff rule.
 *  - DIFF: every bit that changes on a row — allow OR deny, set OR cleared —
 *    must be one the actor holds in the target, resolved BEFORE the change
 *    (i.e. against the saved baseline). Bits already on a row that the
 *    actor leaves alone are fine even if they lack them.
 *
 * "Holds in the target" is the client-side resolver (`resolveEffective`, the
 * same algorithm the server runs) over the inherited category tier and the
 * saved baseline of the edited target, for the current user as a member —
 * including their server timeout, which strips SEND_MESSAGES / SPEAK.
 */

import { ALL_PERMISSIONS, Permissions, isAdministrator } from '@cipherline/shared';
import { resolveEffective, type PermRole, type PermTier } from './effectivePermissions';
import { tierFromDraft } from './accessSummary';
import { memberKey, roleKey, type DraftMap, type EditGuard } from './overrideDraft';

export interface GuardMember {
    user_id: string;
    role_ids: readonly string[];
    muted_until?: string | null;
}

export interface GuardInput {
    roles: readonly PermRole[];
    members: readonly GuardMember[];
    ownerUserId: string | null | undefined;
    currentUserId: string | null | undefined;
    /** The caller's resolved SERVER-level bits (GET /servers/:id/me/permissions).
     *  Used for the owner/admin verdict, and as the fallback for `editable`
     *  when the member list (and so the caller's own row) is unavailable. */
    myPermissions: bigint;
    /** Overrides as currently saved on the server for the edited target. */
    baseline: DraftMap;
    /** Which tier the baseline is. */
    scope: 'channel' | 'category';
    /** The tiers the edited target inherits (a channel's parent category). */
    inheritedTiers: readonly PermTier[];
}

export interface GuardResult extends EditGuard {
    /** Owner or ADMINISTRATOR: nothing is gated. */
    privileged: boolean;
    /** Why a target is locked, for its tooltip. */
    lockReasons: ReadonlyMap<string, string>;
    myHighestPosition: number;
    /** False when the caller lacks VIEW_CHANNEL or MANAGE_CHANNELS in the
     *  target itself — the server refuses every write there. */
    canManageHere: boolean;
    /**
     * The caller's effective bits in the target for an arbitrary override set
     * of it — what the server will see as "before" at each step of a save.
     * Undefined when it cannot be computed (owner/admin, or no member row):
     * the save then keeps its default request order.
     */
    resolveMine?: (draft: DraftMap) => bigint;
}

const SCOPE_BITS = Permissions.VIEW_CHANNEL | Permissions.MANAGE_CHANNELS;

export function computeGuard(input: GuardInput): GuardResult {
    const privileged =
        (!!input.currentUserId && input.currentUserId === input.ownerUserId)
        || isAdministrator(input.myPermissions)
        || input.myPermissions === ALL_PERMISSIONS;

    const lockReasons = new Map<string, string>();
    if (privileged) {
        return {
            privileged, editable: ~0n, baseline: input.baseline, lockedKeys: new Set(), lockReasons,
            myHighestPosition: Infinity, canManageHere: true,
        };
    }

    const pos = new Map(input.roles.map(r => [r.role_id, r.position]));
    const highestOf = (roleIds: readonly string[]) =>
        roleIds.reduce((m, id) => Math.max(m, pos.get(id) ?? -1), -1);
    const me = input.members.find(m => m.user_id === input.currentUserId);
    const myHighest = me ? highestOf(me.role_ids) : -1;

    // Hierarchy: strictly below. Equal is locked too — that is what the
    // server enforces (and what Server Settings → Roles already did).
    for (const r of input.roles) {
        if (r.is_everyone) continue;
        if (r.position >= myHighest) lockReasons.set(roleKey(r.role_id), 'At or above your highest role');
    }
    for (const m of input.members) {
        if (m.user_id === input.ownerUserId) lockReasons.set(memberKey(m.user_id), 'Server owner');
        else if (m.user_id !== input.currentUserId && highestOf(m.role_ids) >= myHighest) {
            lockReasons.set(memberKey(m.user_id), 'Has a role at or above yours');
        }
    }

    // What the caller holds IN the target, before this draft is saved.
    const tierLabel = input.scope === 'channel' ? 'this channel' : 'this category';
    const resolveMine = me
        ? (draft: DraftMap) => resolveEffective(
            { roles: input.roles, ownerUserId: input.ownerUserId, tiers: [...input.inheritedTiers, tierFromDraft(input.scope, tierLabel, draft)] },
            { kind: 'member', userId: me.user_id, roleIds: me.role_ids, mutedUntil: me.muted_until ?? null },
        ).perms
        : undefined;
    const mine = resolveMine ? resolveMine(input.baseline) : input.myPermissions;
    const canManageHere = (mine & SCOPE_BITS) === SCOPE_BITS;

    return {
        privileged,
        editable: canManageHere ? mine : 0n,
        baseline: input.baseline,
        lockedKeys: new Set(lockReasons.keys()),
        lockReasons,
        myHighestPosition: myHighest,
        canManageHere,
        resolveMine,
    };
}
