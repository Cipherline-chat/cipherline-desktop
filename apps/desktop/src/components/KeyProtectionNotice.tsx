import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ClBanner } from './ClBanner';
import { keyProtectionNoticeCopy, type KeyProtectionNoticeCopy } from '../utils/keyProtectionNotice';

/**
 * G8 — one-time notice when this device's master key is not protected by an
 * OS keyring (Linux `basic_text` fallback, or no keystore at all). The main
 * process decides whether it is due (`secure:get-key-protection`) and records
 * the dismissal (`secure:ack-key-protection-notice`), so it shows once per
 * distinct weak state rather than on every launch. Renders nothing otherwise,
 * and nothing at all on a preload that predates the bridge.
 */
export const KeyProtectionNotice: React.FC = () => {
    const [copy, setCopy] = useState<KeyProtectionNoticeCopy | null>(null);

    useEffect(() => {
        let alive = true;
        const api = window.electronAPI;
        if (!api?.getKeyProtection) return;
        api.getKeyProtection()
            .then(p => { if (alive && p.showNotice) setCopy(keyProtectionNoticeCopy(p.level, p.reason)); })
            .catch(() => { /* informational only — never block on it */ });
        return () => { alive = false; };
    }, []);

    if (!copy) return null;

    const dismiss = () => {
        setCopy(null);
        void window.electronAPI?.ackKeyProtectionNotice?.().catch(() => { /* shows again next launch */ });
    };

    return (
        <ClBanner
            id="key-protection"
            tone="info"
            priority={35}
            icon={<KeyRound size={15} />}
            title={copy.title}
            description={copy.body}
            dismissLabel="Got it"
            onDismiss={dismiss}
        />
    );
};

export default KeyProtectionNotice;
