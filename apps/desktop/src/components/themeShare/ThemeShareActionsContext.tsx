/**
 * What "Send to a friend" (the custom theme Share dialog) needs from the
 * Dashboard, without reaching into it — the same shape as the gift UI's
 * GiftActionsContext. Dashboard owns the friends list and the E2EE send path;
 * the Share dialog renders inside SettingsScreen, which Dashboard mounts.
 * Outside the provider (tests, harnesses) every action is "not available".
 *
 * A theme goes to a friend as an ORDINARY end-to-end encrypted text message
 * holding the theme link (theme/themeLink.ts). The server relays ciphertext
 * as for any other message: it never sees the theme, the link, or that the
 * message is a theme at all.
 */
import React, { createContext, useContext } from 'react';
import type { PickerFriend, PickerStatusEntry } from '../../utils/peoplePicker';

export interface ThemeShareActions {
    /** False outside the Dashboard (no friends, no send path). */
    available: boolean;
    /** Accepted friends (the only people a DM can go to). */
    friends: PickerFriend[];
    /** The conversation list (marks friends you already have a DM with). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Dashboard's conversation rows are untyped JSON
    conversations: any[];
    friendStatuses?: Record<string, PickerStatusEntry | undefined>;
    presence?: Record<string, boolean | undefined>;
    lastActivityAt?: Record<string, number>;
    /**
     * Send `text` as an E2EE text message into the DM with `userId` (opening
     * the DM if needed — the API allows that only for accepted friends) and
     * append it to that thread. Resolves true once it went out. Never throws.
     */
    sendText: (userId: string, text: string) => Promise<boolean>;
}

const DEFAULT_ACTIONS: ThemeShareActions = {
    available: false,
    friends: [],
    conversations: [],
    sendText: async () => false,
};

const ThemeShareActionsContext = createContext<ThemeShareActions>(DEFAULT_ACTIONS);

export const ThemeShareActionsProvider: React.FC<{ value: ThemeShareActions; children: React.ReactNode }> = ({ value, children }) => (
    <ThemeShareActionsContext.Provider value={value}>{children}</ThemeShareActionsContext.Provider>
);

// eslint-disable-next-line react-refresh/only-export-components -- the context's hook lives with its provider (as GiftActionsContext)
export function useThemeShareActions(): ThemeShareActions {
    return useContext(ThemeShareActionsContext);
}
