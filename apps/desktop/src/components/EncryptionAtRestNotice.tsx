import React, { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { ClButton } from './cl';
import { secureLocalStore } from '../utils/secureLocalStore';

/**
 * Warns when this device has no OS keyring, so Cipherline's local data
 * (the secureLocalStore KV) is kept unencrypted on disk. It used to be a
 * `position: fixed` bar in App.tsx that sat ON TOP of the app and covered the
 * title area and whatever banner was beneath it. It now lives in the Dashboard's
 * in-flow banner stack, is one slim line, and can be dismissed for this session
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
        <div
            role="status"
            data-testid="encryption-at-rest-notice"
            className="w-full px-3 py-1.5 bg-amber-600/90 text-white text-xs flex items-center justify-between gap-3"
        >
            <div className="flex items-center gap-2 min-w-0">
                <ShieldAlert size={13} className="shrink-0" />
                <span className="truncate" title="Install a keyring (libsecret / GNOME Keyring) to enable it.">
                    No system keyring — local data on this computer is stored unencrypted. Install a keyring (libsecret / GNOME Keyring) to enable encryption.
                </span>
            </div>
            <ClButton type="button" icon variant="ghost" size="sm" tooltip="Dismiss until next launch" onClick={() => setDismissed(true)}>
                <X size={12} />
            </ClButton>
        </div>
    );
};

export default EncryptionAtRestNotice;
