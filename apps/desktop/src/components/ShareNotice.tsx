import React from 'react';
import { ClNote } from './cl/ClNote';
import { ClButton } from './ClButton';

/**
 * A transient in-call screen-share notice (platform limit, capture stall,
 * encoder/codec trouble, HDR turned off...). Same note family as the picker's
 * frame-rate disclaimers - `ClNote`, `warn` for something that needs attention,
 * `info` otherwise - with a dismiss control at the far edge.
 */
export const ShareNotice: React.FC<{
    tone: 'info' | 'warn';
    onDismiss: () => void;
    children: React.ReactNode;
    className?: string;
}> = ({ tone, onDismiss, children, className }) => (
    <ClNote
        tone={tone}
        className={className}
        data-testid="share-notice"
        action={
            <ClButton icon variant="ghost" size="sm" onClick={onDismiss} className="clb--icon-xs" tooltip="Dismiss">✕</ClButton>
        }
    >
        {children}
    </ClNote>
);
