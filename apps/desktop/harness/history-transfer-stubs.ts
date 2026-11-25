/* eslint-disable -- harness stubs, not shipped */
// Stand-ins used ONLY by the history-transfer harness (see history-transfer.vite.config.ts).

// ── contexts/AuthContext ──
export const useAuth = () => ({ token: 'harness-token', userId: 'me', deviceId: 'dev-new' });

// ── hooks/useOwnDevicePresence: this account's other devices ──
const now = Date.now();
export const useOwnDevicePresence = () => ({
    devices: [
        { device_id: 'dev-new', device_name: 'This laptop', platform: 'linux', connected: true, attentive: true, last_active_at: now, last_seen_at: new Date(now).toISOString() },
        { device_id: 'dev-desk', device_name: 'Desk PC', platform: 'windows', connected: true, attentive: true, last_active_at: now, last_seen_at: new Date(now).toISOString() },
        { device_id: 'dev-phone', device_name: 'Dawson’s iPhone', platform: 'ios', connected: false, attentive: false, last_active_at: null, last_seen_at: new Date(now - 3_600_000).toISOString() },
        { device_id: 'dev-old', device_name: 'Old MacBook', platform: 'mac', connected: false, attentive: false, last_active_at: null, last_seen_at: new Date(now - 40 * 86_400_000).toISOString() },
    ],
    loading: false, error: '', refresh: async () => undefined,
});

// ── utils/secureLocalStore: in-memory ──
const mem = new Map<string, string>();
const store: any = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    flushNow: async () => undefined,
};
export const secureLocalStore = store;
export default store;
