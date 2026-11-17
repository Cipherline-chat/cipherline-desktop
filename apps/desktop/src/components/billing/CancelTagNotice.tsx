/**
 * The cancel-confirmation line for the #number (desktop BillingTab, and the
 * founder slide-to-cancel modal, which renders the same block). Owner,
 * 2026-11-16: "list it when try to cancel letting them know they will lose
 * that feature". Names their number when it is a CHOSEN one (it will be
 * replaced with a random one when Pro ends); otherwise the generic line. The
 * API (DiscriminatorLapseService) is what actually does it.
 */
import React from 'react';
import { Hash } from 'lucide-react';
import { discriminatorCancelNotice } from '../../utils/discriminatorField';

export const CancelTagNotice: React.FC<{ discriminator: number | null; custom: boolean }> = ({ discriminator, custom }) => (
    <p
        data-cancel-tag-notice={custom ? 'custom' : 'generic'}
        className="text-[12.5px] leading-relaxed flex items-start gap-2"
        style={{ color: custom ? 'var(--cl-glow)' : 'var(--cl-faint)', margin: '0 0 12px' }}
    >
        <Hash size={13} className="shrink-0" style={{ marginTop: 3 }} aria-hidden />
        <span>{discriminatorCancelNotice({ discriminator, custom })}</span>
    </p>
);

export default CancelTagNotice;
