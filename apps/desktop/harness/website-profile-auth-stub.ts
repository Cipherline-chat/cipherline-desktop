/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the website-profile harness only (see website-profile.vite.config.ts).
// The viewer is identified by ?me=<user id>; the token is a placeholder (the capture script authenticates).
const me = new URLSearchParams(location.search).get('me') ?? 'viewer';
export const useAuth = () => ({
    token: 'harness', userId: me, deviceId: 'harness-device',
    user: { user_id: me, username: 'viewer', discriminator: 1, avatar_url: null, created_at: '2026-01-01T00:00:00Z' },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
