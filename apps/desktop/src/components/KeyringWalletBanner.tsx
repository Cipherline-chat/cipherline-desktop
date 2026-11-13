import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ClBanner } from './ClBanner';
import { normalizeKeyringStatus, walletBannerCopy, type KeyringStatus } from '../utils/walletPrompt';

/**
 * Linux: the system wallet (KDE Wallet / GNOME Keyring) was not unlocked at
 * startup, but the app is running anyway (the user supplied their recovery key,
 * or an earlier run left a plaintext key). The keys are NOT protected by the
 * wallet this session, and unlike the "no keyring found" notices this is
 * fixable right now: "Unlock wallet" relaunches Cipherline, which asks the
 * wallet again at startup (a refused wallet is cached by the process, so an
 * in-place retry is impossible).
 *
 * Dismissible for this session only; it is back on the next launch until the
 * wallet is unlocked, because the condition is real and persists. Renders
 * nothing on Windows / macOS, with an unlocked wallet, or with a preload that
 * predates the bridge.
 */
export const KeyringWalletBanner: React.FC = () => {
    const [status, setStatus] = useState<KeyringStatus | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        const api = window.electronAPI;
        if (!api?.getKeyringStatus) return;
        api.getKeyringStatus()
            .then(raw => { if (alive) setStatus(normalizeKeyringStatus(raw)); })
            .catch(() => { /* informational only: never block on it */ });
        return () => { alive = false; };
    }, []);

    if (dismissed || !status || !status.degraded) return null;
    const copy = walletBannerCopy(status);

    const retry = () => {
        setBusy(true); setFailed(false);
        void (window.electronAPI?.retryKeyringUnlock?.() ?? Promise.resolve(false))
            .then(ok => { if (!ok) { setBusy(false); setFailed(true); } })
            .catch(() => { setBusy(false); setFailed(true); });
    };

    return (
        <ClBanner
            id="keyring-wallet-locked"
            tone="warning"
            priority={66}
            testId="keyring-wallet-banner"
            icon={<KeyRound size={15} />}
            title={copy.title}
            description={failed ? 'Couldn’t restart Cipherline. Close it and open it again to be asked for your password.' : copy.description}
            actions={[{ key: 'unlock', label: copy.action, onClick: retry, loading: busy }]}
            dismissLabel={copy.dismiss}
            onDismiss={() => setDismissed(true)}
        />
    );
};

export default KeyringWalletBanner;
