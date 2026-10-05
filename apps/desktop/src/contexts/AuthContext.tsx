import { fetchWithRetry } from '../utils/fetchWithRetry';
import secureLocalStore from '../utils/secureLocalStore';
import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import * as ed from '@noble/ed25519';
import { dropSessionMedia } from '../utils/sessionMedia';
import { settleBootRefresh, BOOT_REFRESH_WAIT_MS } from '../utils/bootRefresh';

interface AuthState {
    isAuthenticated: boolean;
    token: string | null;
    userId: string | null;
    deviceId: string | null;
    user: { user_id: string, username: string, email: string | null, discriminator: number | null, bio: string | null, avatar_url: string | null, banner_url: string | null, created_at?: string | null } | null;
    /** Set when this session was force-revoked by the server (password change / disable).
     *  Shown as a banner on the login screen, then cleared on next login. */
    logoutReason: string | null;
}

interface AuthContextType extends AuthState {
    /**
     * True while the context is reading from localStorage on first mount.
     * App.tsx renders a skeleton screen during this window to prevent the
     * one-frame flash of the login screen before session restore completes.
     */
    initializing: boolean;
    /** The _isPairingPending param is accepted for backward compat with existing
     *  call sites but is ignored — all devices are auto-approved by the server. */
    login: (token: string, userId: string, deviceId: string, _isPairingPending?: boolean, refreshToken?: string) => void | Promise<void>;
    /** `reason` is shown as a banner on the login screen (see `logoutReason`). */
    logout: (reason?: string | null) => void;
    refreshAccessToken: () => Promise<string | null>;
    refreshProfile: () => Promise<void>;
    /** Swap in a fresh token pair without a full login cycle. Used by
     *  ChangePasswordModal after a successful password change — the server
     *  re-issues tokens so the current session survives while other sessions
     *  are invalidated. */
    updateTokens: (accessToken: string, refreshToken: string) => void;
    /** Clear the logoutReason banner once it has been displayed. */
    clearLogoutReason: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Decode the expiry time from a JWT without verifying the signature (client-side only use). */
function getJwtExpiry(token: string): number | null {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp ?? null; // unix seconds
    } catch {
        return null;
    }
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [authState, setAuthState] = useState<AuthState>({
        isAuthenticated: false,
        token: null,
        userId: null,
        deviceId: null,
        user: null,
        logoutReason: null,
    });

    /**
     * True until the mount effect finishes reading localStorage (and waiting
     * for any token refresh). Prevents the login-screen flash on startup.
     */
    const [initializing, setInitializing] = useState(true);

    const refreshProfile = useCallback(async () => {
        const token = secureLocalStore.getItem('cipherline_token');
        if (!token) return;
        try {
            // Retried: this single request is what puts the user's OWN avatar
            // (and name) on screen. One lost call during the cold-start window
            // used to blank it for the whole session with nothing to revive it.
            const res = await fetchWithRetry(
                () => axios.get(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } }),
                { attempts: 4, onRetry: (_e, n) => console.warn(`[auth] profile retry ${n}`) },
            );
            setAuthState(prev => ({ ...prev, user: res.data }));
        } catch (err) {
            console.error('Failed to fetch profile', err);
        }
    }, []);

    // CRIT-11: Single in-flight refresh promise. Concurrent 401s share one
    // round-trip — only the first fires; the rest await the same result.
    const refreshPromiseRef = React.useRef<Promise<string | null> | null>(null);

    const refreshAccessToken = useCallback(async (): Promise<string | null> => {
        if (refreshPromiseRef.current) return refreshPromiseRef.current;

        const _doRefresh = async (): Promise<string | null> => {
            const storedRefresh = secureLocalStore.getItem('cipherline_refresh_token');
            if (!storedRefresh) return null;
            try {
                // 15s timeout so a captive portal / hung TCP can't leave the boot
                // sequence waiting forever — this call gates `initializing`, and
                // without a timeout a socket that opens but never responds traps
                // the user on the loading skeleton with no way forward. A refresh
                // should complete in well under 15s on any usable connection; a
                // timeout falls through to the offline-tolerant path below (keep
                // the existing token). Scoped to this request only — a global
                // axios timeout could clip legitimately-slow calls (avatar blob
                // fetches, large history pulls).
                const res = await axios.post(`${API_BASE}/auth/refresh`, { refresh_token: storedRefresh }, { timeout: 15000 });
                const { access_token, refresh_token } = res.data;
                // CRIT-10: Persist the rotated refresh token so it can be used next time.
                secureLocalStore.setItem('cipherline_token', access_token);
                if (refresh_token) secureLocalStore.setItem('cipherline_refresh_token', refresh_token);
                setAuthState(prev => ({ ...prev, token: access_token }));
                return access_token;
            } catch (err) {
                // Only force-logout when the server explicitly rejects the refresh
                // token (401 / 403). Network errors (no response object) mean the
                // device is offline — wiping credentials would log the user out for
                // no reason, so we return null and let the caller fall back to the
                // existing access token.
                const isNetworkError = axios.isAxiosError(err) && !err.response;
                if (isNetworkError) {
                    console.warn('[AuthContext] Token refresh failed (offline) — keeping existing session');
                    return null;
                }

                // Server said the refresh token is invalid — force re-login.
                // This is the fallback discovery path for a device with no live
                // WS at the moment of revocation (backgrounded/asleep) — the
                // WS 4403 path (see the session-revoked listener below) already
                // has its own friendly message; this one must too, or a device
                // that only finds out this way gets silently bounced with no
                // explanation at all.
                dropSessionMedia();
                secureLocalStore.removeItem('cipherline_token');
                secureLocalStore.removeItem('cipherline_refresh_token');
                secureLocalStore.removeItem('cipherline_user_id');
                secureLocalStore.removeItem('cipherline_device_id');
                secureLocalStore.removeItem('cipherline_is_pairing');
                setAuthState({
                    isAuthenticated: false, token: null, userId: null,
                    deviceId: null, user: null,
                    logoutReason: 'Your session has ended. Please sign in again.',
                });
                return null;
            }
        };

        refreshPromiseRef.current = _doRefresh().finally(() => {
            refreshPromiseRef.current = null;
        });
        return refreshPromiseRef.current;
    }, []);

    // On mount, restore session from localStorage and optionally refresh the
    // access token if it's close to expiry.  Sets initializing = false when
    // done so App.tsx can stop showing the skeleton screen.
    useEffect(() => {
        const token = secureLocalStore.getItem('cipherline_token');
        const userId = secureLocalStore.getItem('cipherline_user_id');
        const deviceId = secureLocalStore.getItem('cipherline_device_id');
        // Clear the legacy pairing flag — all devices are auto-approved now.
        secureLocalStore.removeItem('cipherline_is_pairing');

        if (token && userId && deviceId) {
            const exp = getJwtExpiry(token);
            const now = Math.floor(Date.now() / 1000);
            // If token expires within 24 hours, proactively refresh it now.
            if (exp && (exp - now) < 86400) {
                // Genuinely expired (not just "close to expiry") — a token in
                // this state will be rejected by every API call regardless of
                // what we do here, so restoring "authenticated" only trades a
                // clean sign-in prompt for a confusing wall of 401s. A token
                // that's merely within the 24h refresh window but NOT yet
                // expired keeps its existing offline tolerance below (still
                // valid, so still safe to use while offline).
                const tokenAlreadyExpired = exp <= now;
                // PERF (wake → open app → long hang): this refresh gates the
                // whole app (`initializing`), and right after the PC wakes the
                // network is often still coming back, so it could sit on its
                // full 15 s timeout with the user staring at the loading
                // screen. While the token is still VALID there is no reason
                // to wait that long: after BOOT_REFRESH_WAIT_MS the session is
                // restored with the existing (unexpired) token and the refresh
                // finishes in the background (refreshAccessToken itself swaps
                // the new token in when it lands, or signs out on a server
                // rejection — unchanged). An already-expired token still waits
                // for the refresh: it must never be used.
                settleBootRefresh(refreshAccessToken(), {
                    tokenExpired: tokenAlreadyExpired,
                    expSec: exp,
                    waitMs: BOOT_REFRESH_WAIT_MS,
                }, (newToken) => {
                    // If refreshAccessToken returned null the call either failed
                    // (network error → keep existing token, unless it's already
                    // expired — see above) or the server rejected it (→ already
                    // logged out inside refreshAccessToken). Either way, use the
                    // original token as the active token.
                    const activeToken = newToken ?? token;
                    const serverRejected = !secureLocalStore.getItem('cipherline_token');
                    const staleAndUnrefreshed = newToken === null && tokenAlreadyExpired;
                    // Only restore the session if we're not already logged out
                    // by the server-rejection branch inside refreshAccessToken,
                    // and not sitting on a definitely-dead token with no way to
                    // confirm a fresh one.
                    setAuthState(prev =>
                        (prev.isAuthenticated === false && newToken === null && serverRejected) || staleAndUnrefreshed
                            ? prev // server rejected, or token is dead and unconfirmable — stay logged out
                            : {
                                isAuthenticated: true,
                                token: activeToken,
                                userId,
                                deviceId,
                                user: { user_id: userId, username: '', email: null, discriminator: null, bio: null, avatar_url: null, banner_url: null },
                                logoutReason: null,
                            }
                    );
                    setInitializing(false);
                    // The refresh branch restored the session with a blank
                    // profile (avatar_url null) and never fetched the real one -
                    // so anyone opening the app within a day of token expiry
                    // had no avatar all session. Same fetch as the other branch.
                    if (secureLocalStore.getItem('cipherline_token')) void refreshProfile();
                });
            } else {
                setAuthState({
                    isAuthenticated: true,
                    token,
                    userId,
                    deviceId,
                    user: { user_id: userId, username: '', email: null, discriminator: null, bio: null, avatar_url: null, banner_url: null },
                    logoutReason: null,
                });
                refreshProfile();
                setInitializing(false);
            }
        } else {
            // No stored session — user is logged out. Done initializing.
            setInitializing(false);
        }
    }, [refreshProfile, refreshAccessToken]);

    // Force-logout when the WS gateway sends a session-revoked close (4403).
    useEffect(() => {
        const onRevoked = (e: Event) => {
            const message = (e as CustomEvent<{ message: string }>).detail?.message
                ?? 'Your session was ended. Please sign in again.';
            logout(message);
        };
        window.addEventListener('cipherline:session-revoked', onRevoked);
        return () => window.removeEventListener('cipherline:session-revoked', onRevoked);
    // logout is stable (no deps that change) — intentionally omitted to avoid
    // re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const login = async (token: string, userId: string, deviceId: string, _isPairingPending?: boolean, refreshToken?: string) => {
        // Ensure device identity exists before writing login state
        if (!secureLocalStore.getItem('cipherline_private_key')) {
            const privKey = ed.utils.randomSecretKey();
            const pubKey = await ed.getPublicKeyAsync(privKey);
            secureLocalStore.setItem('cipherline_private_key', btoa(String.fromCharCode(...privKey)));
            secureLocalStore.setItem('cipherline_public_key', btoa(String.fromCharCode(...pubKey)));
        }

        secureLocalStore.setItem('cipherline_token', token);
        secureLocalStore.setItem('cipherline_user_id', userId);
        secureLocalStore.setItem('cipherline_device_id', deviceId);
        secureLocalStore.removeItem('cipherline_is_pairing');
        if (refreshToken) {
            secureLocalStore.setItem('cipherline_refresh_token', refreshToken);
        }

        // Writing cipherline_user_id starts decrypting this account's records
        // (an IndexedDB read + WebCrypto) - which the Dashboard's mount used to
        // race and lose: its persist effects read a still-cold namespace, got
        // null, and wrote '[]' over the real home pins (and every other
        // per-account setting with that shape). Wait for the records first.
        // Ordinary boot never hit this: hydrate() binds the account before
        // anything renders. Only an explicit sign-in does.
        await secureLocalStore.whenAccountReady();

        setAuthState({
            isAuthenticated: true,
            token,
            userId,
            deviceId,
            user: { user_id: userId, username: '', email: null, discriminator: null, bio: null, avatar_url: null, banner_url: null },
            logoutReason: null,
        });

        refreshProfile();
    };

    const logout = (reason: string | null = null) => {
        dropSessionMedia();
        secureLocalStore.removeItem('cipherline_token');
        secureLocalStore.removeItem('cipherline_refresh_token');
        secureLocalStore.removeItem('cipherline_user_id');
        secureLocalStore.removeItem('cipherline_device_id');
        secureLocalStore.removeItem('cipherline_is_pairing');

        setAuthState({
            isAuthenticated: false,
            token: null,
            userId: null,
            deviceId: null,
            user: null,
            logoutReason: reason,
        });
    };

    const clearLogoutReason = useCallback(() => {
        setAuthState(prev => ({ ...prev, logoutReason: null }));
    }, []);

    const updateTokens = useCallback((accessToken: string, refreshToken: string) => {
        secureLocalStore.setItem('cipherline_token', accessToken);
        secureLocalStore.setItem('cipherline_refresh_token', refreshToken);
        setAuthState(prev => ({ ...prev, token: accessToken }));
    }, []);

    return (
        <AuthContext.Provider value={{ ...authState, initializing, login, logout, refreshAccessToken, refreshProfile, updateTokens, clearLogoutReason }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
