/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext AND src/contexts/SubscriptionContext in the
// window-sizes harness only (see window-sizes.vite.config.ts).
const user = { user_id: 'me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson', avatar_url: null, banner_url: null };
const auth = {
    token: 'harness-token', userId: 'me', deviceId: '11111111-1111-4111-8111-111111111111', user, isAuthenticated: true,
    refreshProfile: async () => {}, updateTokens: () => {}, login: async () => {}, logout: () => {},
};
export const useAuth = () => auth;
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
const sub = {
    status: null, statusError: null, isPaid: true, isFreeTier: false, canPublishVideo: true, canCreateServer: true,
    maxUploadBytes: 2 * 1024 ** 3, planInterval: 'month', isYearlyOffered: false, planPrices: null,
    pendingInterval: null, pendingIntervalAt: null,
    previewIntervalChange: async () => ({ ok: false }), changeInterval: async () => ({ ok: false }),
    refresh: async () => {}, extendTrial: async () => ({ ok: false }), promptUpgrade: () => {}, openInAppCheckout: () => {},
    celebratePro: () => {},
};
export const useSubscription = () => sub;
export const SubscriptionProvider = ({ children }: { children: unknown }) => children as any;
