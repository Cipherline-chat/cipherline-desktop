/**
 * ServerIcon — renders a server's icon attachment, with the 2-letter
 * abbreviation as fallback. Decrypts the encrypted blob client-side using
 * the inline key + nonce stored on the Server row.
 *
 * Why a separate component (vs reusing EncryptedAvatar):
 *   - Server icons aren't user-scoped (no friend-gate / profile-open click),
 *     so the EncryptedAvatar hooks would be no-ops at best.
 *   - The fallback shape is different: a colored abbreviation card, not a
 *     single-person silhouette.
 *
 * Animated icons / banners (GIF, animated WebP - free for everyone): the same
 * rule as animated avatars. A list shows the FIRST FRAME and plays on hover;
 * a surface that IS the open server (its banner, its settings preview) passes
 * `animate`. Nothing plays while Cipherline is not the focused window
 * (utils/animatedImage `useStillGate`). Static images ignore all of it.
 *
 * Sizes: pass `className` for the wrapper (controls dimensions). The
 * abbreviation auto-scales relative to the wrapper's font size — set
 * `text-[Npx]` in className to match the size you want.
 */

import React, { useState } from 'react';
import { useEncryptedAvatar, avatarUrlMime } from '../../hooks/useEncryptedAvatar';
import { mayBeAnimated, useStillGate } from '../../utils/animatedImage';
import { userColor } from '../../utils/avatarColor';
import { safeImageSrc } from '../../utils/safeMediaUrl';

interface Props {
    /** Server id — drives the deterministic fallback color. */
    serverId: string;
    /** Server name — drives the 2-letter abbreviation in the fallback. */
    name: string;
    attachmentId: string | null;
    keyB64: string | null;
    nonceB64: string | null;
    token: string | null;
    /** Wrapper classes (size, rounding). */
    className?: string;
    /** An animated image plays here (while the app is in front). Default false:
     *  lists show the first frame and play on hover. The server rail passes this
     *  only for the server you are in (owner 2026-10-31). */
    animate?: boolean;
    /** A PARENT says "play now" (e.g. the pointer is over the rail tile around
     *  this icon). Transient, unlike `animate`. */
    playing?: boolean;
}

function abbreviate(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

export const ServerIcon: React.FC<Props> = ({ serverId, name, attachmentId, keyB64, nonceB64, token, className, animate = false, playing = false }) => {
    const inlineKey = (attachmentId && keyB64 && nonceB64) ? { keyB64, nonceB64 } : null;
    // Only a validated image URL (blob:, data:image/*, trusted https) ever reaches <img src>.
    const fullUrl = safeImageSrc(useEncryptedAvatar(attachmentId, token, inlineKey)) ?? null;
    const mime = avatarUrlMime(fullUrl);
    const [hovered, setHovered] = useState(false);
    const url = useStillGate(fullUrl, mime, animate || hovered || playing);
    // Kept on while `animate` is true: clicking a rail tile turns `animate` on under
    // the pointer, and dropping these then missed the leave, so the icon kept playing
    // after you moved to another server.
    const hover = mayBeAnimated(mime)
        ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
        : undefined;

    if (url) {
        return <img src={url} alt={name} className={`object-cover ${className ?? ''}`} {...hover} />;
    }

    const bg = userColor(serverId);
    return (
        <div
            className={`flex items-center justify-center font-bold ${className ?? ''}`}
            style={{ backgroundColor: bg, color: '#000000' }}
            title={name}
            {...hover}
        >
            {abbreviate(name)}
        </div>
    );
};
