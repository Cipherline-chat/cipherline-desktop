import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ClBanner } from './ClBanner';
import { secureLocalStore } from '../utils/secureLocalStore';

/**
 * Warns when this device has no OS keyring, so Cipherline's local data
 * (the secureLocalStore KV) is kept unencrypted on disk. It used to be a
 * `position: fixed` bar in App.tsx that sat ON TOP of the app and covered the
 * title area and whatever banner was beneath it. It now lives in the Dashboard's
 * in-flow banner stack, and can be dismissed for this session
 * (it comes back on the next launch — the condition is real and persists).
 *
 * Distinct from KeyProtectionNotice (G8), which covers the weaker case where a
 * master key exists but is only obscured; this one is the "no master key at
 * all" case.
 */
export const EncryptionAtRestNotice: React.FC = () => {
    const [dismissed, setDismissed] = useState(false);
    if (dismissed || secureLocalStore.masterKeyStatus() !== 'absent') return null;

    return (
        <ClBanner
            id="encryption-at-rest"
            tone="warning"
            priority={62}
            testId="encryption-at-rest-notice"
            icon={<ShieldAlert size={15} />}
            title="No system keyring"
            description="Local data on this computer is stored unencrypted. Install a keyring (libsecret / GNOME Keyring) to enable encryption."
            dismissLabel="Dismiss until next launch"
            onDismiss={() => setDismissed(true)}
        />
    );
};

export default EncryptionAtRestNotice;
