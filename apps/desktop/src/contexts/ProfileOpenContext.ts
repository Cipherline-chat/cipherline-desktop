import { createContext, useContext } from 'react';

/**
 * Global handler for opening a user's profile popover. Wired once at the
 * Dashboard root — any descendant (EncryptedAvatar, usernames, etc.) can
 * call `useOpenProfile()(userId, anchor)` to bring up the popover near
 * the click position.
 *
 * `anchor` (optional) lets the caller tell the popover where to appear —
 * typically the click's viewport coordinates. Without an anchor, the
 * popover defaults to top-center of the viewport.
 */
export interface ProfileAnchor {
    x: number;
    y: number;
}
export interface ProfileRoleCtx {
    roleIds: string[];
    roles: Array<{ role_id: string; name: string; color: number }>;
    /** Server the profile was opened from — enables nickname editing and lazy role fetch. */
    serverId?: string;
    currentNickname?: string | null;
    canSetNickname?: boolean;
    /** Open straight into the nickname editor instead of the profile card's
     *  resting state — used by "Change Nickname" shortcuts (e.g. the call
     *  participant self-menu) that skip the intermediate "View Profile" step.
     *  Has no effect unless `canSetNickname` is also true. Fires once the
     *  effective nickname is known (immediately if `currentNickname` was
     *  supplied, otherwise after ProfileModal's lazy fetch resolves). */
    autoEditNickname?: boolean;
}

export type OpenProfileFn = (userId: string, anchor?: ProfileAnchor, roleCtx?: ProfileRoleCtx) => void;

export const ProfileOpenContext = createContext<OpenProfileFn | null>(null);

/** Returns the open-profile callback if a provider is installed, else null. */
export function useOpenProfile(): OpenProfileFn | null {
    return useContext(ProfileOpenContext);
}
