/* eslint-disable -- harness stubs, not shipped */
// Stand-ins for the contexts/hooks the real banners read, in the banners harness only.
// The banners themselves, ClBanner, ClButton and every stylesheet are the REAL ones.
import React from 'react';
declare global { interface Window { __sub?: any; __anns?: any[]; __keyring?: string } }

export const useAuth = () => ({ token: 'harness-token', userId: 'u-me', deviceId: 'dev-1', user: { user_id: 'u-me', username: 'Dawson' } });
export const AuthProvider = ({ children }: { children: unknown }) => children as any;

/** Per-instance billing status for the gallery (several TrialBanners at different states). */
export const SubOverride = React.createContext<any>(null);
export const useSubscription = () => ({
    status: React.useContext(SubOverride) ?? window.__sub ?? null,
    extendTrial: async () => ({ ok: true }),
    openInAppCheckout: () => {},
    refresh: async () => {},
});

export const useToast = () => ({ push: () => {} });

export const UpdateCardModal = () => null;

export const useAnnouncements = () => window.__anns ?? [];

const kv = new Map<string, string>();
export const secureLocalStore = {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => { kv.set(k, v); },
    removeItem: (k: string) => { kv.delete(k); },
    masterKeyStatus: () => window.__keyring ?? 'present',
};
export default secureLocalStore;
