import { useCallback, useEffect, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import {
    readDeviceStorageDecision, markDeviceStorageSetupDone, saveDeviceStorageChoice,
    type DeviceRetentionChoice, type SetupHow,
} from '../utils/deviceStorageSetup';

/**
 * 'checking' — the account's records are not loaded yet, or the decision
 *              hasn't been read. Nothing is shown AND the retention sweeper
 *              stays held (Dashboard gates it on 'done').
 * 'prompt'   — this device has never chosen a retention for this account.
 * 'done'     — it has (or it is a pre-existing install, adopted silently).
 */
export type DeviceStorageStatus = 'checking' | 'prompt' | 'done';

/**
 * The single hook point for the first-run "storage on this device" prompt.
 * Mounted once, by Dashboard, for whichever account is signed in — so every
 * login path (password today, QR / device-link later, with or without a
 * restore or history transfer after it) reaches it with no per-path wiring.
 * See utils/deviceStorageSetup.ts for the rule and the keys.
 */
export function useDeviceStorageSetup(userId: string | null | undefined) {
    const [state, setState] = useState<{ uid: string | null; status: DeviceStorageStatus }>(
        { uid: userId ?? null, status: 'checking' },
    );

    useEffect(() => {
        // No reset to 'checking' here: `status` below is derived per account,
        // so a new userId reads as 'checking' until this effect resolves it.
        if (!userId) return;
        let cancelled = false;
        void (async () => {
            // Per-account records are COLD right after an explicit sign-in
            // until the store has decrypted them. Reading before that sees null
            // for both keys and would prompt an account that already chose.
            // Loop: a rebind that starts while we wait replaces the promise.
            for (let i = 0; i < 5 && !cancelled && !secureLocalStore.isAccountReady(userId); i++) {
                try { await secureLocalStore.whenAccountReady(); } catch { /* re-checked below */ }
            }
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            let status: DeviceStorageStatus;
            try {
                const decision = readDeviceStorageDecision(userId);
                if (decision === 'adopt-existing') {
                    // An install from before this feature: it already has a
                    // policy, so record that silently rather than nag.
                    try { markDeviceStorageSetupDone(userId, 'existing-install'); } catch { /* retried next launch */ }
                    status = 'done';
                } else {
                    status = decision === 'done' ? 'done' : 'prompt';
                }
            } catch {
                // Unreadable store — ask rather than assume. Asking is
                // harmless; assuming 'done' would run the sweeper on defaults.
                status = 'prompt';
            }
            if (!cancelled) setState({ uid: userId, status });
        })();
        return () => { cancelled = true; };
    }, [userId]);

    const complete = useCallback((choice: DeviceRetentionChoice, how: SetupHow) => {
        if (!userId) throw new Error('No signed-in account');
        saveDeviceStorageChoice(userId, choice, how); // throws on failure
        setState({ uid: userId, status: 'done' });
    }, [userId]);

    // A render between a userId change and the effect above must not report
    // the PREVIOUS account's status.
    const status: DeviceStorageStatus = state.uid === (userId ?? null) ? state.status : 'checking';
    return { status, complete };
}
