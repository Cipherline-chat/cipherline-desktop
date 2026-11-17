import { createContext, useContext } from 'react';

/**
 * The member role picker from anywhere under the Dashboard, the way
 * ProfileOpenContext serves "open this user's profile":
 *  - the member-list and chat message right-click menus show it as a hover
 *    flyout beside the menu (MemberRolesFlyout, via `session`);
 *  - the profile card's "+" opens it as a popover anchored to the button
 *    (MemberRolePicker, via `open`).
 * Both render the same body (MemberRolePickerBody → RolePickerList).
 *
 * `canAssignRoles(serverId)` is a UX mirror only (MANAGE_ROLES/ADMINISTRATOR
 * plus "at least one role below my highest", see rolePickerModel). The API
 * enforces both on every PUT/DELETE.
 */
export interface OpenRolePickerArgs {
    serverId: string;
    userId: string;
    /** Viewport point the popover opens next to (a click, or a button's corner). */
    anchor: { x: number; y: number };
    /** Shown in the picker's header. */
    displayName?: string;
    /** Role ids to start from when the roster for this server is not cached yet. */
    fallbackRoleIds?: readonly string[];
    /** The button that opened it, refocused on close. */
    returnFocusTo?: HTMLElement | null;
}

/** What a role picker body needs to load the roster and send toggles. */
export interface RolePickerSession {
    token: string;
    myUserId: string;
    ownerUserId: string | null;
    perms: bigint;
}

export interface RolePickerApi {
    open: (args: OpenRolePickerArgs) => void;
    /** Credentials + permission bits for an in-menu picker; null when signed out. */
    session: (serverId: string) => RolePickerSession | null;
    canAssignRoles: (serverId: string | null | undefined) => boolean;
    /** Highest role position the viewer may toggle below (mirror of the server's hierarchy check). */
    actorHighest: (serverId: string | null | undefined) => number;
    /** The open picker's target, so an opener can reflect aria-expanded. */
    openFor: { serverId: string; userId: string } | null;
}

export const RolePickerContext = createContext<RolePickerApi | null>(null);

export function useRolePicker(): RolePickerApi | null {
    return useContext(RolePickerContext);
}
