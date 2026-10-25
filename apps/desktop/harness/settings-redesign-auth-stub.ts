/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the settings-redesign harness only.
const user = {
    user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson',
    bio: 'Building the quiet internet.', avatar_url: null, banner_url: null, email: 'dawson@example.com',
};
const value = {
    token: 'harness-token', userId: 'u-me', deviceId: 'dev-1', user, isAuthenticated: true,
    refreshProfile: async () => {}, updateTokens: () => {}, login: async () => {}, logout: () => {},
};
export const useAuth = () => value;
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
