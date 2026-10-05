/**
 * MsgBarBtn — one flat icon action inside the message hover toolbar (.msgbar).
 *
 * Deliberately not a ClButton: the kit button's ringed capsule face is right
 * for standalone actions but reads as a wall of chrome when seven of them sit
 * in a strip. These are the toolbar equivalent of context-menu rows — quiet
 * muted icons that tint lume on hover (flash for the destructive one), with
 * the kit's pill tooltip above. Styles live in index.css under `.msgbar*`.
 */

import React from 'react';
import { useClTooltip } from '../cl/useClTooltip';

interface MsgBarBtnProps {
    icon: React.ReactNode;
    label: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Lume-tinted persistent state (pinned/saved). */
    active?: boolean;
    /** With `active`, tints glow/amber instead of lume (server save). */
    warm?: boolean;
    /** Flash tint on hover — destructive actions. */
    danger?: boolean;
    /** Shown but inert (e.g. "Saved (pinned)" — unpin first). Uses
     *  aria-disabled rather than the `disabled` attribute so the tooltip
     *  explaining WHY still appears on hover/focus. */
    disabled?: boolean;
}

export const MsgBarBtn: React.FC<MsgBarBtnProps> = ({ icon, label, onClick, active, warm, danger, disabled }) => {
    // Same portal/collision machinery as ClButton — the message toolbar sits in
    // a scrolling, overflow-clipped list, which is exactly where the old inline
    // `.mtip` sibling got cut off.
    const { anchorProps, tooltip } = useClTooltip(label);
    const { ref: tooltipRef, ...tooltipHandlers } = anchorProps;
    return (
        <button
            ref={tooltipRef as React.Ref<HTMLButtonElement>}
            type="button"
            aria-label={label}
            aria-pressed={active}
            aria-disabled={disabled || undefined}
            className={[
                'msgbar-btn',
                active ? 'on' : '',
                warm ? 'warm' : '',
                danger ? 'danger' : '',
                disabled ? 'disabled' : '',
            ].filter(Boolean).join(' ')}
            onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(e); }}
            onContextMenu={(e) => e.stopPropagation()}
            {...tooltipHandlers}
        >
            {icon}
            {tooltip}
        </button>
    );
};
