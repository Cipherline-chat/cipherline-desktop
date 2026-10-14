/**
 * The cancel-confirmation line for owned servers over the free 25 MB
 * (desktop BillingTab). Renders nothing when none are — the count comes from
 * useOwnedServersOverFreeStorage, which only runs while the confirmation is open.
 */
import React from 'react';
import { HardDrive } from 'lucide-react';
import { cancelServerStorageNotice } from '../../utils/serverStorageGrace';

export const CancelServerStorageNotice: React.FC<{ overCount: number }> = ({ overCount }) => {
    const text = cancelServerStorageNotice(overCount);
    if (!text) return null;
    return (
        <p
            data-cancel-storage-notice
            className="text-[12.5px] leading-relaxed flex items-start gap-2"
            style={{ color: 'var(--cl-glow)', margin: '0 0 12px' }}
        >
            <HardDrive size={13} className="shrink-0" style={{ marginTop: 3 }} />
            <span>{text}</span>
        </p>
    );
};

export default CancelServerStorageNotice;
