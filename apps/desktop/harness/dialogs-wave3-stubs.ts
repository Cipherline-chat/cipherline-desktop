/* eslint-disable -- harness stubs, not shipped */
// Stand-ins used ONLY by the dialogs-wave3 harness (see dialogs-wave3.vite.config.ts).
// One module, several vite aliases — each alias points at a named export bundle below
// through a tiny re-export file so the real components import their usual names.

const q = new URLSearchParams(location.search);

// ── contexts/AuthContext ──
export const useAuth = () => ({
    token: 'harness-token', userId: 'me', deviceId: 'dev-1',
    user: { user_id: 'me', username: 'Dawson', email: 'dawson@example.com', avatar_url: null },
    updateTokens: () => {},
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;

// ── contexts/ToastContext ──
export const useToast = () => ({ push: (t: unknown) => { ((window as any).__toasts ||= []).push(t); } });

// ── contexts/SubscriptionContext ──
export const useSubscription = () => ({ openInAppCheckout: () => { (window as any).__checkout = true; } });

// ── utils/historyRequestProof ──
export const HISTORY_REFUSED_LEGACY_REQUESTER = 'requester_cannot_receive_wrapped_key';
export const verifyHistoryRequestAdvertisement = () => (q.get('verdict') === 'refused' ? { ok: false, reason: 'missing' } : { ok: true }) as any;

// ── utils/historyTransferKey ──
export async function fetchOwnDeviceKeyBundle() {
    const v = q.get('verdict');
    if (v === 'checking') return new Promise<never>(() => {});
    if (v === 'error') throw new Error('network');
    return { device_id: 'req-1', identity_key_pub_b64: 'AAAA' } as any;
}
export async function wrapHistoryTransferKey() { return {} as any; }

// ── utils/secureLocalStore: in-memory, always hydrated (the real one needs the Electron keystore) ──
const mem = new Map<string, string>();
const storeImpl: any = new Proxy({
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    isAccountReady: () => true,
    whenAccountReady: async () => {},
    isHydrated: () => true,
    keys: () => [...mem.keys()],
}, { get: (t: any, p) => (p in t ? t[p] : () => undefined) });
export const secureLocalStore = storeImpl;
export default storeImpl;
