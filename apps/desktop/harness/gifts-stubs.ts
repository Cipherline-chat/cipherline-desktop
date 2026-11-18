/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext AND src/contexts/SubscriptionContext in the
// Gift Pro harness only (see gifts.vite.config.ts). Counts subscription refreshes so
// the shots script can assert Pro is unlocked after an accept.
const w = window as any;
w.__refreshes = 0;
export const useAuth = () => ({ token: 'harness-token', userId: 'me', deviceId: '11111111-1111-4111-8111-111111111111', user: { user_id: 'me', username: 'Robin' } });
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
w.__celebrations = 0;
w.__celebratedAt = null;
export const useSubscription = () => ({
    refresh: async () => { w.__refreshes++; },
    // Records WHEN the Pro welcome was asked for, so the shots script can assert
    // it happens once, after the unwrap (not over it).
    celebratePro: () => {
        w.__celebrations++; w.__celebratedAt = performance.now();
        // gifts-main.tsx (?welcome=1) mounts the real ProWelcome on this, like Dashboard does.
        window.dispatchEvent(new Event('harness:celebrate'));
    },
});
export const SubscriptionProvider = ({ children }: { children: unknown }) => children as any;
