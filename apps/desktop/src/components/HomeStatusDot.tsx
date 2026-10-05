import React from 'react';
import { StatusDot } from './StatusIcon';
import type { UserStatus } from '../utils/userStatusModel';

/**
 * The presence dot on the Home deck's avatars (conversation rows, friends
 * rows, "Pick back up" cards).
 *
 * The deck drew its own `.hd-dot` spans and never learnt about the phone
 * icon, so someone present only on their phone showed a plain dot there
 * while every other surface showed the phone — and the conversation rows
 * were always GREEN whatever the status, because they read the bare
 * online/offline poll. This is the one place the deck renders a dot now, and
 * its "on mobile" form is the shared `StatusDot` (MobileStatusGlyph), exactly
 * as the friends list, DM list and member lists render it.
 *
 * Kept dependency-light (no HomePanel imports) so it renders in vitest.
 */

// The deck's own semantic colours (theme tokens rather than the hex values
// in STATUS_CONFIG — the deck is themed through --cl-*).
const HOME_DOT_COLOR: Record<UserStatus, string> = {
    online: 'var(--cl-ok)',
    away: 'var(--cl-glow)',
    dnd: 'var(--cl-flash)',
    offline: 'var(--cl-faint)',
};

export const HomeStatusDot: React.FC<{ status: UserStatus; onMobile?: boolean }> = ({ status, onMobile }) => {
    if (onMobile && status !== 'offline') {
        return (
            <span className="hd-dot hd-dot--mobile">
                <StatusDot status={status} onMobile size={10} />
            </span>
        );
    }
    return <span className="hd-dot" style={{ background: HOME_DOT_COLOR[status] ?? HOME_DOT_COLOR.offline }} />;
};
