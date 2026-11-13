/* eslint-disable -- harness stub, not shipped */
// Stand-in for src/contexts/AuthContext in the settings-merge harness only: a user WITH a verified Steam link.
const user = {
    user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson',
    bio: 'Building the quiet internet.', avatar_url: null, banner_url: null, email: 'dawson@example.com',
    steam: { steam_id: '76561197960287930' },
    profile_level: { level: 7, points: 310, next_level_points: 400, showcase_slots: 4 },
    profile_showcase: { blocks: ['links', 'games', 'steam'], top_achievements: [] },
    profile_links: [{ platform: 'x', handle: 'dawsonk' }], widget_games: ['Hollow Knight', 'Celeste'],
};
const value = {
    token: 'harness-token', userId: 'u-me', deviceId: 'dev-1', user, isAuthenticated: true,
    refreshProfile: async () => {}, updateTokens: () => {}, login: async () => {}, logout: () => {},
};
export const useAuth = () => value;
export const AuthProvider = ({ children }: { children: unknown }) => children as any;
