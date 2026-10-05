import { createContext, useContext } from 'react';

/**
 * When the local user is in a server voice/huddle call, Dashboard sets this
 * context so that deep call components (ParticipantCard, PopoverMenu) can
 * enrich `openProfile` calls with the server context — enabling role chips
 * and nickname management in the profile popover without threading extra
 * props through the entire call component tree.
 *
 * null when not in a server voice call (DM / group calls).
 */
export interface CallServerCtxValue {
    serverId: string;
    /** Viewer can change their own server nickname (CHANGE_NICKNAME or ADMINISTRATOR). */
    canChangeOwnNick: boolean;
    /** Viewer can change other members' server nicknames (MANAGE_NICKNAMES or ADMINISTRATOR). */
    canManageNick: boolean;
}

export const CallServerCtx = createContext<CallServerCtxValue | null>(null);

/** Returns the current call's server context, or null if not in a server call. */
export function useCallServerCtx(): CallServerCtxValue | null {
    return useContext(CallServerCtx);
}
