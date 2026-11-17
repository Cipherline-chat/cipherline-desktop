/**
 * categoryDelete — what the "Delete category" confirm should say, decided
 * before the request (owner decision 2026-11-16).
 *
 * A PRIVATE top-level category that still holds sub-categories cannot be
 * deleted: the server refuses with 409 (CategoriesService.delete), because
 * deleting it promotes the sub-categories to top level and drops the tier
 * that hides them. The client mirrors that so the dialog can say so up front
 * (Delete disabled, with the way out) instead of failing after a click. It is
 * UX only: when the client cannot tell (overrides failed to load), it lets the
 * user try and shows the server's message if refused.
 *
 * "Private" is the server's rule (PermissionsService.categoryRestrictsView),
 * evaluated with the client's mirror of the resolver (resolveEffective):
 * the category's tier takes VIEW_CHANNEL away from @everyone, or from a holder
 * of any single role, compared with that role base alone; or a member override
 * on it denies VIEW_CHANNEL.
 */

import { Permissions } from '@cipherline/shared';
import { resolveEffective, type PermOverride, type PermRole } from './channelPerms/effectivePermissions';

export function categoryRestrictsView(roles: readonly PermRole[], overrides: readonly PermOverride[]): boolean {
    const VIEW = Permissions.VIEW_CHANNEL;
    if (overrides.some(o => o.target_kind === 'member' && (o.deny & VIEW) !== 0n)) return true;
    const tier = { kind: 'category' as const, label: 'this category', overrides };
    for (const r of roles) {
        const subject = { kind: 'role' as const, roleId: r.role_id };
        const base = resolveEffective({ roles, ownerUserId: null, tiers: [] }, subject);
        if (!base.has(VIEW)) continue;
        const after = resolveEffective({ roles, ownerUserId: null, tiers: [tier] }, subject);
        if (!after.has(VIEW)) return true;
    }
    return false;
}

export interface CategoryDeleteConfirm {
    title: string;
    message: string;
    hint?: string;
    confirmDisabled?: boolean;
}

/** The server's 409 wording, so the client and the refusal read the same. */
export const privateParentMessage = (name: string) =>
    `Move or delete the sub-categories in "${name}" first. It's private, and deleting it would make them visible to everyone who can see the server.`;

export function categoryDeleteConfirm(input: {
    name: string;
    isSub: boolean;
    parentName?: string | null;
    hasSubcategories: boolean;
    /** null = unknown (could not load its overrides): let the server decide. */
    isPrivate: boolean | null;
}): CategoryDeleteConfirm {
    if (input.isSub) {
        return {
            title: `Delete "${input.name}"?`,
            message: `Its channels and dividers move up into ‘${input.parentName ?? 'the category'}’.`,
        };
    }
    if (input.hasSubcategories && input.isPrivate === true) {
        return {
            title: `Can't delete "${input.name}" yet`,
            message: privateParentMessage(input.name),
            hint: 'Drag each sub-category into another category, or change "Sits in" under Edit Sub-category.',
            confirmDisabled: true,
        };
    }
    return {
        title: `Delete "${input.name}"?`,
        message: input.hasSubcategories
            ? 'Channels inside will become uncategorized; its sub-categories become categories.'
            : 'Channels inside will become uncategorized.',
    };
}
