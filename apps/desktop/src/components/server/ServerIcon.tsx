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
 * Sizes: pass `className` for the wrapper (controls dimensions). The
 * abbreviation auto-scales relative to the wrapper's font size — set
 * `text-[Npx]` in className to match the size you want.
 */

import React from 'react';
import { useEncryptedAvatar } from '../../hooks/useEncryptedAvatar';
import { userColor } from '../../utils/avatarColor';

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
}

function abbreviate(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

export const ServerIcon: React.FC<Props> = ({ serverId, name, attachmentId, keyB64, nonceB64, token, className }) => {
    const inlineKey = (attachmentId && keyB64 && nonceB64) ? { keyB64, nonceB64 } : null;
    const url = useEncryptedAvatar(attachmentId, token, inlineKey);

    if (url) {
        return <img src={url} alt={name} className={`object-cover ${className ?? ''}`} />;
    }

    const bg = userColor(serverId);
    return (
        <div
            className={`flex items-center justify-center font-bold ${className ?? ''}`}
            style={{ backgroundColor: bg, color: '#000000' }}
            title={name}
        >
            {abbreviate(name)}
        </div>
    );
};
