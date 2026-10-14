/* eslint-disable -- visual harness, not shipped */
// Stand-in for contexts/AuthContext: ScreenLockOverlay only needs logout().
export const useAuth = () => ({ logout: () => {} });
