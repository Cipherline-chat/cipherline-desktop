import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { publishIdentityBundle, isRetryableUploadError } from '../utils/keyBundleUpload';

/**
 * Ensures the device's Signal key bundle is uploaded to the server on every
 * Dashboard mount. This guarantees the bundle exists regardless of whether the
 * user went through AuthScreen (first login) or was auto-restored from
 * localStorage (subsequent app launches).
 *
 * Returns `bundleReady: true` once the server has the bundle; encryption
 * operations should wait for this flag before proceeding.
 */
export function useKeyBundleSync(): { bundleReady: boolean; bundleError: string | null } {
    const { token, deviceId } = useAuth();
    const [bundleReady, setBundleReady] = useState(false);
    const [bundleError, setBundleError] = useState<string | null>(null);
    const attemptedRef = useRef(false);

    useEffect(() => {
        // Guard: need auth + Electron IPC
        if (!token || !deviceId) return;
        if (!window.electronAPI?.ensureIdentityBundle) {
            // Non-Electron environment (plain browser) — no E2EE possible, skip
            console.warn('[E2EE] No electronAPI available — skipping key bundle sync');
            setBundleReady(true);
            return;
        }

        // Prevent double-fire from React StrictMode
        if (attemptedRef.current) return;
        attemptedRef.current = true;

        const sync = async () => {
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    console.log(`[E2EE] Key bundle sync: attempt ${attempt} for device ${deviceId}`);

                    // Generate or load the identity, then publish the current
                    // signed prekey + a gated, capped prekey set (see
                    // publishIdentityBundle for what is re-offered and why).
                    await publishIdentityBundle(deviceId, token);

                    console.log('[E2EE] Key bundle sync: upload succeeded');
                    setBundleReady(true);
                    setBundleError(null);
                    return; // Success — exit retry loop
                } catch (err: any) {
                    const msg = err?.response?.data?.message || err?.message || 'Unknown error';
                    console.error(`[E2EE] Key bundle sync: attempt ${attempt} failed —`, msg);

                    // A 4xx is the server's settled answer about this body;
                    // re-sending it fails the same way. Only network/5xx retry.
                    if (attempt < maxRetries && isRetryableUploadError(err)) {
                        // Exponential backoff: 1s, 2s, 4s
                        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                    } else {
                        console.error(`[E2EE] Key bundle sync: gave up after attempt ${attempt}`);
                        setBundleError(`Key bundle upload failed: ${msg}`);
                        // Still set bundleReady so the UI isn't permanently locked —
                        // individual encryption calls will show their own errors
                        setBundleReady(true);
                        return;
                    }
                }
            }
        };

        sync();
    }, [token, deviceId]);

    return { bundleReady, bundleError };
}
