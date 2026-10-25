import { useAuth } from '../contexts/AuthContext';

/**
 * The signed-in token, or null when there is no AuthProvider above (a test
 * rendering one profile surface on its own, a preview harness). The profile
 * seams (useProfileActivity / useProfileConnections) only need the token to
 * READ integrations; without one they simply show nothing extra, never throw.
 *
 * Safe as a hook: useAuth always calls useContext before it may throw, so the
 * hook order is the same with or without a provider.
 */
export function useOptionalToken(): string | null {
    try {
        return useAuth().token ?? null;
    } catch {
        return null;
    }
}
