import React from 'react';
import { MobileStatusGlyph } from '../MobileStatusGlyph';
import { StatusLine } from '../StatusLine';
import { STATUS_CONFIG } from '../../hooks/useUserStatus';
import type { FriendStatusEntry } from '../../hooks/useUserStatus';

/** The presence line + custom status shown under a name on the profile card (the game is the activity row below it). */
export const ProfilePresence: React.FC<{
    entry: FriendStatusEntry;
    userId: string;
    onMobile: boolean;
    /** "Last seen 3h ago" replaces the status when offline. */
    lastSeen: string | null;
}> = ({ entry, userId, onMobile, lastSeen }) => {
    const cfg = STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.offline;
    return (
        <>
            <span className="pcd-status-line">
                {lastSeen ? <span>{lastSeen}</span> : (
                    <>
                        <span className="pcd-status-dot" style={{ backgroundColor: cfg.color }} aria-hidden="true" />
                        <b style={{ color: cfg.color }}>{cfg.label}</b>
                        {onMobile && <span>· on mobile</span>}
                    </>
                )}
            </span>
            {/* Custom status (offline = none; expired = none). */}
            {entry.status !== 'offline' && (
                <StatusLine entry={{ ...entry, current_game: null }} userId={userId} animate className="pcd-custom" />
            )}
        </>
    );
};

/** The status dot (or the phone glyph) on the avatar. */
export const ProfileAvatarBadge: React.FC<{ entry: FriendStatusEntry; onMobile: boolean }> = ({ entry, onMobile }) => {
    const cfg = STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.offline;
    return onMobile ? (
        <span className="pcd-mobile" title={`${cfg.label} · on mobile`}>
            <MobileStatusGlyph status={entry.status} size={16} />
        </span>
    ) : (
        <span className="pcd-dot" style={{ backgroundColor: cfg.color }} title={cfg.label} />
    );
};
