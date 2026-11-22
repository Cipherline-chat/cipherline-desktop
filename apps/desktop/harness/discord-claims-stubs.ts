/* eslint-disable -- harness stub, not shipped */
// AuthContext / SubscriptionContext stand-ins for the discord-claims harness: the signed-in TEST account (?as=) comes
// from window.__HARNESS (set by discord-claims-main.tsx from the isolated local API's setup output).
const me = () => {
    const h = (globalThis as any).__HARNESS;
    const as = (globalThis as any).__AS ?? 'sam';
    return h?.[as] ?? { user_id: 'me', device_id: 'dev', token: 't', name: 'sam' };
};
export const useAuth = () => {
    const u = me();
    return {
        token: u.token, userId: u.user_id, deviceId: u.device_id,
        user: { user_id: u.user_id, username: u.name, discriminator: 1, display_name: u.name, avatar_url: null, banner_url: null },
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
