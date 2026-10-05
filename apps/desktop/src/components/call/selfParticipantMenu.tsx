import { User, Pencil } from 'lucide-react';
import type { ContextMenuItem } from '../primitives/ContextMenu';

/**
 * Menu items for right-clicking YOUR OWN row in a call participant list.
 *
 * Pulled out as a pure builder (rather than inlined JSX in the row's
 * onContextMenu handler) for one reason: FloatingHuddleCard's away-from-
 * server roster and ServerContextPanel's in-server huddle roster must offer
 * the SAME options for the local user's own row, and a shared function is
 * the only way to guarantee that stays true as either surface changes —
 * two hand-copied item lists WILL drift (this is exactly how the remote-
 * participant menu almost regressed: see PopoverMenu.tsx's docblock).
 *
 * Mirrors ServerContextPanel's `buildMemberMenu`'s self branch: "View
 * Profile" always, "Change Nickname" only when the caller's server grants
 * CHANGE_NICKNAME (the @everyone default — see
 * packages/shared/permissions.ts's DEFAULT_EVERYONE_PERMISSIONS) or
 * ADMINISTRATOR. Deliberately does NOT reproduce buildMemberMenu's Roles
 * submenu (self-role-assignment for MANAGE_ROLES/ADMINISTRATOR holders) —
 * that needs the server's role list, which isn't available to every caller
 * of this builder (e.g. FloatingHuddleCard, once the user has navigated
 * away from the call's server). Role membership itself is still visible
 * read-only on the profile card via ProfileModal's own lazy fetch.
 */
export interface SelfParticipantMenuOptions {
    /** CHANGE_NICKNAME (or ADMINISTRATOR) in the call's server. */
    canChangeOwnNick: boolean;
    /** Opens the profile card. Centered, not at the click point — a
     *  ContextMenuItem's onSelect carries no event to anchor on (same
     *  convention as buildMemberMenu / buildCallParticipantMenu /
     *  HuddleParticipantPopover's own "View Profile" rows). */
    onViewProfile: () => void;
    /** Opens the profile card straight into its nickname editor. Only
     *  invoked when `canChangeOwnNick` is true, so callers may pass a
     *  no-op when they don't intend to offer the item — but the item is
     *  only actually rendered when `canChangeOwnNick` is true regardless. */
    onChangeNickname: () => void;
}

export function buildSelfParticipantMenuItems(opts: SelfParticipantMenuOptions): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
        { icon: <User size={15} />, label: 'View Profile', onSelect: opts.onViewProfile },
    ];
    if (opts.canChangeOwnNick) {
        items.push({ icon: <Pencil size={15} />, label: 'Change Nickname', onSelect: opts.onChangeNickname });
    }
    return items;
}
