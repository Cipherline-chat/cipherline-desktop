/**
 * What the gift UI needs from the Dashboard, without reaching into it.
 *
 * Settings -> Subscription (BillingTab) renders inside SettingsScreen, which
 * Dashboard mounts; the chat card renders inside ChatPane. Neither owns the
 * friends list or the E2EE send path — Dashboard does (globalFriends, the
 * signal_chat encrypt-and-send used by server invites). Dashboard provides
 * this context around both; outside it (tests, the screenshot harness) the
 * defaults below make every action a clean "not available".
 */
import React, { createContext, useContext } from 'react';

export interface GiftFriend {
    user_id: string;
    username: string | null;
    discriminator?: number | null;
    avatar_url?: string | null;
}

export interface GiftActions {
    /** Accepted friends (the only people a gift can go to). */
    friends: GiftFriend[];
    /**
     * Send the E2EE `pro_gift` card ({ type: 'pro_gift', gift_id }) into the
     * DM with `recipientUserId` (opening the DM if needed — the API allows that
     * only for accepted friends) and append it to the thread optimistically.
     * Resolves true once the message went out. Never throws.
     */
    sendGiftCard: (recipientUserId: string, giftId: string) => Promise<boolean>;
    /** Display name for a user id, from what this client already knows. */
    nameFor: (userId: string | null | undefined) => string | null;
}

const DEFAULT_ACTIONS: GiftActions = {
    friends: [],
    sendGiftCard: async () => false,
    nameFor: () => null,
};

const GiftActionsContext = createContext<GiftActions>(DEFAULT_ACTIONS);

export const GiftActionsProvider: React.FC<{ value: GiftActions; children: React.ReactNode }> = ({ value, children }) => (
    <GiftActionsContext.Provider value={value}>{children}</GiftActionsContext.Provider>
);

export function useGiftActions(): GiftActions {
    return useContext(GiftActionsContext);
}
