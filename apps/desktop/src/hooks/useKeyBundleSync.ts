import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE } from '../constants';

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

                    // Generate or load the key bundle from the Electron main process
                    const bundle = await window.electronAPI!.ensureIdentityBundle(deviceId);

                    // Upload to the server (idempotent — uses upsert on device_id PK)
                    await axios.post(`${API_BASE}/keys/upload_bundle`, {
                        device_id:              bundle.device_id,
                        identity_key_pub_b64:   bundle.identity_key_pub_b64,
                        registration_id:        bundle.registration_id,
                        signed_prekey_id:       bundle.signed_prekey.id,
                        signed_prekey_pub_b64:  bundle.signed_prekey.pub_b64,
                        signed_prekey_sig_b64:  bundle.signed_prekey.sig_b64,
                        one_time_prekeys:       bundle.one_time_prekeys,
                    }, { headers: { Authorization: `Bearer ${token}` } });

                    console.log('[E2EE] Key bundle sync: upload succeeded');
                    setBundleReady(true);
                    setBundleError(null);
                    return; // Success — exit retry loop
                } catch (err: any) {
                    const msg = err?.response?.data?.message || err?.message || 'Unknown error';
                    console.error(`[E2EE] Key bundle sync: attempt ${attempt} failed —`, msg);

                    if (attempt < maxRetries) {
                        // Exponential backoff: 1s, 2s, 4s
                        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                    } else {
                        console.error('[E2EE] Key bundle sync: permanently failed after 3 attempts');
                        setBundleError(`Key bundle upload failed: ${msg}`);
                        // Still set bundleReady so the UI isn't permanently locked —
                        // individual encryption calls will show their own errors
                        setBundleReady(true);
                    }
                }
            }
        };

        sync();
    }, [token, deviceId]);

    return { bundleReady, bundleError };
}
