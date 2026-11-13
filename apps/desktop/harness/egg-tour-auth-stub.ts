/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the egg-tour harness only (see egg-tour.vite.config.ts).
// A brand-new account (created an hour ago) whose profile the harness can change at runtime
// (window.__setProfile), so AchievementsHost sees an avatar arrive exactly like refreshProfile() does.
import { useSyncExternalStore } from 'react';

let user: Record<string, unknown> = {
    user_id: 'me', username: 'Robin', discriminator: 4821, bio: null, avatar_url: null, banner_url: null,
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
};
const subs = new Set<() => void>();
(window as any).__setProfile = (patch: Record<string, unknown>) => { user = { ...user, ...patch }; for (const s of subs) s(); };

export const useAuth = () => {
    const u = useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn); }; }, () => user);
    return { token: 'harness-token', userId: 'me', deviceId: '11111111-1111-4111-8111-111111111111', user: u, refreshProfile: async () => undefined };
};
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
