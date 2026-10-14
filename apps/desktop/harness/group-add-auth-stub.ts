/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the group-add harness only (see group-add.vite.config.ts).
export const useAuth = () => ({
    token: 'harness-token', userId: 'me', deviceId: 'dev-1',
    user: { user_id: 'me', username: 'Dawson', avatar_url: null },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
