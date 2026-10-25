/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the moments harness only (see moments.vite.config.ts).
export const useAuth = () => ({
    token: 'harness-token', userId: 'me', deviceId: 'dev-1',
    user: { user_id: 'me', username: 'Dawson', discriminator: 1234, avatar_url: null, created_at: '2025-10-20T09:00:00Z' },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
