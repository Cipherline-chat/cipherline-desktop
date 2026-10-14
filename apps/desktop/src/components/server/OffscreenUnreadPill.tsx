/**
 * OffscreenUnreadPill — the edge indicator for unread channels scrolled out of
 * view. Presentational: the owner measures (useOffscreenUnread) and decides
 * when to render. A real <button>, so Enter/Space activate it natively and it
 * is in the tab order only while it exists.
 */

import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { pillAriaLabel, pillLabel, type PillSummary } from './offscreenUnread';
import '../../styles/offscreen-unread.css';

interface Props {
    /** Which edge: `below` = unreads under the visible area. */
    direction: 'above' | 'below';
    summary: PillSummary;
    onJump: (direction: 'above' | 'below') => void;
}

export const OffscreenUnreadPill: React.FC<Props> = ({ direction, summary, onJump }) => {
    const Arrow = direction === 'below' ? ArrowDown : ArrowUp;
    return (
        <button
            type="button"
            data-unread-pill={direction}
            data-tone={summary.kind}
            aria-label={pillAriaLabel(direction, summary)}
            onClick={() => onJump(direction)}
            className={`cl-unread-pill cl-unread-pill--${summary.kind} cl-unread-pill--${direction}`}
        >
            <Arrow size={13} strokeWidth={2.75} aria-hidden="true" />
            <span aria-hidden="true">{pillLabel(summary)}</span>
        </button>
    );
};

export default OffscreenUnreadPill;
