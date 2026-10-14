/* eslint-disable -- visual harness, not shipped */
// Stand-in for contexts/AuthContext: NotificationProvider needs userId + isAuthenticated.
export const useAuth = () => ({ userId: 'harness-user', isAuthenticated: true, logout: () => {} });
