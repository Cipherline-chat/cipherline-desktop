/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the dialogs-wave2 harness only.
export const useAuth = () => ({
    token: 'harness-token', userId: 'u-me', deviceId: 'dev-1',
    user: { user_id: 'u-me', username: 'Dawson', avatar_url: 'img-me' },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
