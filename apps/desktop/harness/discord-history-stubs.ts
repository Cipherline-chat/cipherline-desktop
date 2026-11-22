/* eslint-disable -- harness stub, not shipped */
// AuthContext / SubscriptionContext stand-ins for the discord-history harness: the signed-in TEST account comes from
// window.__HARNESS (set by discord-history-main.tsx from the isolated local API's setup output).
const h = () => (globalThis as any).__HARNESS ?? { importer: { user_id: 'me', device_id: 'dev', token: 't', name: 'importer' } };
export const useAuth = () => {
    const me = h().importer;
    return {
        token: me.token, userId: me.user_id, deviceId: me.device_id,
        user: { user_id: me.user_id, username: me.name, discriminator: 1, display_name: me.name, avatar_url: null, banner_url: null },
        isAuthenticated: true, refreshProfile: async () => {}, updateTokens: () => {}, login: async () => {}, logout: () => {},
        logoutReason: null, clearLogoutReason: () => {},
    };
};
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
const sub = {
    status: null, statusError: null, isPaid: false, isFreeTier: true, canPublishVideo: false, canCreateServer: true,
    maxUploadBytes: 100 * 1024 * 1024, planInterval: 'month', isYearlyOffered: false, planPrices: null,
    pendingInterval: null, pendingIntervalAt: null,
    previewIntervalChange: async () => ({ ok: false }), changeInterval: async () => ({ ok: false }),
    refresh: async () => {}, extendTrial: async () => ({ ok: false }), promptUpgrade: () => {}, openInAppCheckout: () => {},
    celebratePro: () => {},
};
export const useSubscription = () => sub;
export const SubscriptionProvider = ({ children }: { children: unknown }) => children as any;
