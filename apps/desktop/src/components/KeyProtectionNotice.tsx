import React, { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { ClButton } from './cl';
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
        <div
            role="status"
            className="w-full px-4 py-2.5 bg-sky-500/10 border-b border-sky-500/25 text-sky-200 text-sm flex items-start justify-between gap-3"
        >
            <div className="flex items-start gap-2 min-w-0">
                <KeyRound size={15} className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                    <div className="font-semibold">{copy.title}</div>
                    <div className="opacity-90">{copy.body}</div>
                </div>
            </div>
            <ClButton type="button" icon variant="ghost" size="sm" tooltip="Got it" onClick={dismiss}>
                <X size={13} />
            </ClButton>
        </div>
    );
};

export default KeyProtectionNotice;
