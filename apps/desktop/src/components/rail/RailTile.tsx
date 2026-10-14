/**
 * Rail tile — 44×44 rounded-square nav tile, verbatim from the Redesign
 * `app.jsx` RailTile (moved out of Dashboard.tsx so the DM/Group right-click
 * menu can be tested without mounting the ~14k-line Dashboard). Active tiles
 * sit on the track's sliding lume pill, so their colour flips to
 * `--cl-on-lume`; accent tiles (add-server) read lume. A faint inset top-light
 * gives the unselected tiles their pressed-into-the-deck look. The numeric
 * badge rides the top-right corner with a sink ring.
 *
 * It stays a single bare <button> — RailTrack measures the pill position from
 * the track's DOM children, so no wrapper element may be added here.
 */
import React from 'react';
import { RailBadge } from '../RailBadge';
import type { BadgeState } from '../../utils/unreadBadges';

export const RailTile: React.FC<{
    icon?: React.ReactNode;
    label?: string;
    title?: string;
    active?: boolean;
    accent?: boolean;
    badge?: BadgeState | null;
    onClick?: () => void;
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
    'aria-haspopup'?: 'menu';
}> = ({ icon, label, title, active, accent, badge, onClick, onContextMenu, onKeyDown, 'aria-haspopup': ariaHasPopup }) => {
    const restColor = active ? 'var(--cl-lume)' : accent ? 'var(--cl-lume)' : 'var(--cl-muted)';
    return (
        <button
            onClick={onClick}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
            aria-haspopup={ariaHasPopup}
            title={title}
            className="no-drag"
            style={{
                position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none',
                background: 'none', cursor: 'pointer', borderRadius: 12, display: 'flex',
                alignItems: 'center', justifyContent: 'center', padding: 0, color: restColor,
                fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 13,
                transition: 'color .2s, background .2s', flex: 'none',
            }}
            onMouseEnter={(e) => {
                if (!active) {
                    e.currentTarget.style.color = 'var(--cl-text)';
                    e.currentTarget.style.background = 'rgba(255,255,255,.06)';
                }
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.color = restColor;
                e.currentTarget.style.background = 'none';
            }}
        >
            {icon || label}
            <RailBadge badge={badge ?? null} />
        </button>
    );
};
