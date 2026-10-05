import { Permissions, hasPermission } from '@cipherline/shared';

/**
 * Who may open Server Settings, and which tabs they see.
 *
 * This exists because the answer used to be written down twice — once in
 * Dashboard (to decide whether to render the gear icon) and once in
 * ServerSettingsModal (to decide which tabs to list) — and the two drifted.
 * The icon list included CREATE_INVITE, but no tab is keyed on CREATE_INVITE,
 * and CREATE_INVITE is in DEFAULT_EVERYONE_PERMISSIONS. So every ordinary
 * member of every server saw the gear, opened it to zero visible tabs, and hit
 * the modal's "fall back to the first tab" path — which handed them the
 * Overview form with the server name and description in editable inputs.
 * (The API rejects the save with 403 — `updateServer` calls
 * requireServerPermission(MANAGE_SERVER) before touching anything — so this was
 * a disclosure/UX failure rather than a privilege escalation. It still showed
 * people controls that were never theirs.)
 *
 * Deriving both answers from this one function makes that class of drift
 * impossible: the icon is shown exactly when at least one tab is visible.
 *
 * All of this is UX only. Every individual write is enforced server-side; none
 * of it is a security boundary.
 */

export type ServerSettingsTab =
    | 'overview' | 'roles' | 'members' | 'invites' | 'bans' | 'audit' | 'emojis';

/**
 * Which tabs this permission set can act in.
 *
 * A tab is visible only when the holder can actually *do* something inside it,
 * so nobody lands on a panel whose every control 403s. Owner and ADMINISTRATOR
 * bypass everything.
 *
 * Note CREATE_INVITE is deliberately absent: inviting people is reachable from
 * the dedicated "Invite People" button in the channel header, and the Invites
 * tab here manages the whole server's invites (including revoking other
 * people's), which is a MANAGE_SERVER-level concern.
 */
export function serverSettingsTabVisibility(
    perms: bigint,
    isOwner: boolean,
): Record<ServerSettingsTab, boolean> {
    const has = (bit: bigint) => hasPermission(perms, bit);
    // The trump card: server owner or ADMINISTRATOR sees everything.
    const all = isOwner || has(Permissions.ADMINISTRATOR);

    return {
        overview: all || has(Permissions.MANAGE_SERVER),
        roles:    all || has(Permissions.MANAGE_ROLES),
        members:  all
            || has(Permissions.KICK_MEMBERS)
            || has(Permissions.BAN_MEMBERS)
            || has(Permissions.MUTE_MEMBERS)
            || has(Permissions.MANAGE_NICKNAMES)
            || has(Permissions.MANAGE_ROLES),
        invites:  all || has(Permissions.MANAGE_SERVER),
        bans:     all || has(Permissions.BAN_MEMBERS),
        audit:    all || has(Permissions.VIEW_AUDIT_LOG),
        emojis:   all || has(Permissions.MANAGE_EMOJIS),
    };
}

/**
 * Whether the Server Settings entry point (gear icon, rail context-menu item)
 * should be offered at all — i.e. whether opening it would show anything.
 */
export function canOpenServerSettings(perms: bigint, isOwner: boolean): boolean {
    return Object.values(serverSettingsTabVisibility(perms, isOwner)).some(Boolean);
}
