import React from 'react';
import { GameControllerIcon } from './GameControllerIcon';
import { MobileStatusGlyph } from './MobileStatusGlyph';
import { type UserStatus, STATUS_CONFIG } from '../utils/userStatusModel';

/**
 * The status dot and its variants — kept free of StatusPicker's UI
 * dependencies so it can be rendered anywhere (and in tests) on its own.
 * StatusPicker re-exports both, which is where most call sites import them.
 */

export const StatusDot: React.FC<{ status: UserStatus; size?: number; onMobile?: boolean }> = ({ status, size = 10, onMobile }) => {
    if (onMobile && status !== 'offline') return <MobileStatusGlyph status={status} size={size} />;
    return (
        <span
            className={status === 'online' ? 'status-online' : undefined}
            style={{
                display: 'inline-block',
                width: size,
                height: size,
                borderRadius: '50%',
                backgroundColor: STATUS_CONFIG[status]?.color ?? '#6b7280',
                flexShrink: 0,
            }}
        />
    );
};

export const StatusIcon: React.FC<{
    status: UserStatus;
    currentGame?: string | null;
    size?: number;
    /** Visibly present on phones only — show the phone instead of the dot. */
    onMobile?: boolean;
}> = ({ status, currentGame, size = 10, onMobile }) => {
    // Hide the "playing" signal entirely when offline — people can't actively
    // be playing if we don't consider them online, and showing the controller
    // there would leak presence. Fall through to the normal offline dot.
    if (currentGame && status !== 'offline' && !onMobile) {
        // Controller tinted with the user's live status color:
        //   online → green, away → orange, dnd → red.
        return <GameControllerIcon size={size + 4} color={STATUS_CONFIG[status]?.color ?? '#22c55e'} />;
    }
    return <StatusDot status={status} size={size} onMobile={onMobile} />;
};
