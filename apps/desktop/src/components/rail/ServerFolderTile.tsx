/**
 * ServerFolderTile — a folder on the left server rail.
 *
 * Same footprint as a server tile (a 44×44 button holding a 40×40 rounded
 * box), so the rail's scroll box, overlay scrollbar, centring/overflow states
 * and the sliding active pill (which measures child boxes) are unaffected.
 * The box shows a 2×2 grid of the folder's FIRST FOUR servers; one to three
 * servers simply leave cells empty. An optional user colour tints the box.
 *
 * Clicking does not expand the rail — it toggles the floating popover
 * (ServerFolderPopover) to the right. Badges are the folder's aggregate:
 * the summed unread/mention pill (serverFolders.aggregateFolderBadge) and the
 * live-call speaker when any server inside has a visible call.
 */

import React from 'react';
import { Volume2 } from 'lucide-react';
import { RailBadge } from '../RailBadge';
import type { BadgeState } from '../../utils/unreadBadges';
import type { RailFolder } from './serverFolders';
import { folderNotchMask, folderTint, notchStyle } from './folderTileStyle';
import '../../styles/server-folders.css';

interface Props {
    folder: RailFolder;
    /** Renders one server's icon; sized by the cell's CSS. */
    renderMini: (serverId: string) => React.ReactNode;
    open: boolean;
    /** The active server is inside this folder (the pill sits here). */
    containsActive: boolean;
    /** Aggregate of the folder's servers, EXCLUDING the active one. */
    badge: BadgeState | null;
    /** People in visible calls across the folder's servers (0 = none). */
    callCount: number;
    buttonRef?: (el: HTMLButtonElement | null) => void;
    onToggle: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    onHover?: (rect: DOMRect) => void;
    onLeave?: () => void;
}

export const ServerFolderTile: React.FC<Props> = ({
    folder, renderMini, open, containsActive, badge, callCount,
    buttonRef, onToggle, onContextMenu, onKeyDown, onHover, onLeave,
}) => {
    const preview = folder.serverIds.slice(0, 4);
    const n = folder.serverIds.length;
    const parts = [`Folder ${folder.name}`, `${n} servers`];
    if (containsActive) parts.push('contains the current server');
    if (badge && badge.tone === 'alert') parts.push(`${badge.count} unread`);
    else if (badge) parts.push('unread');
    if (callCount > 0) parts.push(`${callCount} in call`);
    return (
        <div className="relative group">
            <div
                className="relative"
                onMouseEnter={(e) => onHover?.((e.currentTarget as HTMLElement).getBoundingClientRect())}
                onMouseLeave={() => onLeave?.()}
                onContextMenu={onContextMenu}
            >
                <button
                    ref={buttonRef}
                    type="button"
                    className="no-drag"
                    aria-label={parts.join(', ')}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    data-folder-id={folder.id}
                    onClick={onToggle}
                    onKeyDown={onKeyDown}
                    style={{ position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }}
                >
                    <span className="cl-folder-box" data-open={open ? 'true' : undefined} style={{ ...folderTint(folder), ...notchStyle(folderNotchMask(badge, callCount > 0)) }} aria-hidden>
                        {preview.map(id => (
                            <span key={id} className="cl-folder-cell">{renderMini(id)}</span>
                        ))}
                    </span>
                </button>
                {/* The caller leaves the ACTIVE server out of `badge` (a server
                    tile hides its own badge while active), so the folder keeps
                    showing what is unread in its OTHER servers. */}
                <span aria-hidden={!badge} className="absolute z-10 pointer-events-none" style={{ inset: -7 }}>
                    <RailBadge badge={badge} className="pointer-events-none" />
                </span>
                {callCount > 0 && (
                    <div
                        aria-hidden
                        className="absolute -bottom-1 -right-1 z-10 pointer-events-none flex items-center justify-center rounded-full bg-cl-lume text-cl-on-lume ring-2 ring-cl-abyss"
                        style={{ width: 16, height: 16 }}
                    >
                        <Volume2 size={9} strokeWidth={2.75} aria-hidden />
                    </div>
                )}
            </div>
        </div>
    );
};
