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
    /** Which panel the category is in; a Calls category's channels stay in the Calls panel. */
    panel?: 'text' | 'calls';
}): CategoryDeleteConfirm {
    if (input.panel === 'calls') {
        // What CategoriesService.delete does to a top-level Calls category:
        // its channels and dividers move to the top of the Calls panel. (The
        // Calls panel's old confirm said they would be DELETED - they never were.)
        return {
            title: `Delete "${input.name}"?`,
            message: 'Its Calls channels and dividers move to the top of the Calls panel, outside any category.',
        };
    }
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

// ── "Delete category and everything in it" (user request 2026-11-17) ───────
//
// The server deletes the whole subtree in ONE transaction
// (POST .../categories/:cid/delete-with-contents) and refuses (409, nothing
// deleted) unless the three counts the dialog showed are still true. These
// helpers count from the same lists the sidebar draws - for a manager who may
// delete everything inside (the only case the server allows) those lists
// hold every item.

export interface CategoryContents {
    channels: number;
    subcategories: number;
    dividers: number;
    /** Every channel that would be deleted (the category's and its sub-categories'). */
    channelIds: string[];
}

const isPendingId = (id: string) => id.startsWith('pending:');

/** What is inside a category (and, for a top-level one, inside its sub-categories). */
export function categoryContents(
    categoryId: string,
    lists: {
        categories: ReadonlyArray<{ category_id: string; parent_category_id?: string | null }>;
        channels: ReadonlyArray<{ channel_id: string; parent_category_id?: string | null }>;
        dividers?: ReadonlyArray<{ divider_id: string; parent_category_id: string | null }>;
    },
): CategoryContents {
    const subs = lists.categories.filter(c =>
        c.parent_category_id === categoryId && c.category_id !== categoryId && !isPendingId(c.category_id));
    const containers = new Set([categoryId, ...subs.map(s => s.category_id)]);
    const channelIds = lists.channels
        .filter(ch => !!ch.parent_category_id && containers.has(ch.parent_category_id) && !isPendingId(ch.channel_id))
        .map(ch => ch.channel_id);
    const dividers = (lists.dividers ?? [])
        .filter(d => !!d.parent_category_id && containers.has(d.parent_category_id) && !isPendingId(d.divider_id)).length;
    return { channels: channelIds.length, subcategories: subs.length, dividers, channelIds };
}

export const isEmptyContents = (c: Pick<CategoryContents, 'channels' | 'subcategories' | 'dividers'>) =>
    c.channels === 0 && c.subcategories === 0 && c.dividers === 0;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 channels, 2 sub-categories and 1 divider" (zero counts left out; "nothing" when empty). */
export function contentsSummary(c: Pick<CategoryContents, 'channels' | 'subcategories' | 'dividers'>): string {
    const parts = [
        c.channels ? plural(c.channels, 'channel', 'channels') : null,
        c.subcategories ? plural(c.subcategories, 'sub-category', 'sub-categories') : null,
        c.dividers ? plural(c.dividers, 'divider', 'dividers') : null,
    ].filter((p): p is string => !!p);
    if (parts.length === 0) return 'nothing';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The danger button of the "everything" choice. */
export function deleteEverythingLabel(c: Pick<CategoryContents, 'channels'>): string {
    return c.channels ? `Delete ${plural(c.channels, 'channel', 'channels')}` : 'Delete everything';
}

/** The body the API needs: the counts the user was shown. */
export function expectedCounts(c: Pick<CategoryContents, 'channels' | 'subcategories' | 'dividers'>) {
    return { expected_channels: c.channels, expected_subcategories: c.subcategories, expected_dividers: c.dividers };
}
