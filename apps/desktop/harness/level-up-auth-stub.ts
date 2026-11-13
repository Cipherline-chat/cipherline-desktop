/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the level-up harness only (see level-up.vite.config.ts).
// `window.__server` is what the API would answer for /auth/me profile_level; refreshProfile()
// copies it into `user` exactly when the real one would re-read /auth/me (and counts the calls).
import { useSyncExternalStore } from 'react';

const w = window as any;
w.__server = w.__server ?? { level: 1, points: 2, next_level_points: 4, showcase_slots: 3 };
w.__refreshes = 0;
let user: Record<string, unknown> = { user_id: 'me', username: 'Robin', profile_level: { ...w.__server } };
const subs = new Set<() => void>();
const refreshProfile = async () => {
    w.__refreshes++;
    user = { ...user, profile_level: { ...w.__server } };
    for (const s of subs) s();
};

export const useAuth = () => {
    const u = useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn); }; }, () => user);
    return { token: 'harness-token', userId: 'me', deviceId: '11111111-1111-4111-8111-111111111111', user: u, refreshProfile };
};
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
