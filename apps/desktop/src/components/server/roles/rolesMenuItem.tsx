/**
 * The "Roles ▸" row for a member right-click menu (the server member list
 * and a server channel's message menu): hovering it — or → / Enter on it —
 * opens the shared role picker as a flyout beside the menu (ContextMenu's
 * `flyout` panel), right or left of it, clamped into the window. Toggling a
 * role keeps both the flyout and the menu open.
 *
 * This restores the hover-flyout interaction those menus had before
 * 4ae74fa7 (a `submenu` of checkbox rows) while keeping that commit's picker:
 * role colours, hierarchy filtering, search over 10 roles, scrolling, the
 * "N roles above yours" footer, optimistic toggles with rollback.
 *
 * Only offer it when RolePickerApi.canAssignRoles(serverId) is true (a UX
 * mirror; the API enforces MANAGE_ROLES and the hierarchy).
 */
import { Shield } from 'lucide-react';
import type { ContextMenuItem } from '../../primitives/ContextMenu';
import { MemberRolesFlyout } from './MemberRolePicker';
import { ROLES_FLYOUT_WIDTH } from './rolePickerModel';

export interface RolesMenuItemArgs {
    serverId: string;
    userId: string;
    /** For the flyout's accessible name ("Roles for alice"). */
    displayName?: string;
    /** Role ids to start from when the roster is not cached yet. */
    fallbackRoleIds?: readonly string[];
}

export function rolesMenuItem({ serverId, userId, displayName, fallbackRoleIds }: RolesMenuItemArgs): ContextMenuItem {
    return {
        icon: <Shield />,
        label: 'Roles',
        // Rows that open a flyout do nothing on select; the flyout is the action.
        onSelect: () => {},
        flyoutWidth: ROLES_FLYOUT_WIDTH,
        flyoutLabel: displayName ? `Roles for ${displayName}` : 'Roles',
        flyout: ({ viaKeyboard, maxHeight }) => (
            <MemberRolesFlyout
                serverId={serverId}
                userId={userId}
                displayName={displayName}
                fallbackRoleIds={fallbackRoleIds}
                viaKeyboard={viaKeyboard}
                maxHeight={maxHeight}
            />
        ),
    };
}
