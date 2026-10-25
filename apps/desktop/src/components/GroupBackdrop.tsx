import React, { useState } from 'react';
import { useEncryptedAvatar, evictAvatar } from '../hooks/useEncryptedAvatar';
import { safeImageSrc } from '../utils/safeMediaUrl';
import '../styles/group-hero.css';

interface GroupBackdropProps {
    /** The group picture: an encrypted attachment id (or a local blob:/data: preview). */
    attachmentId?: string | null;
    token: string | null;
}

/**
 * The group picture as a blurred, darkened background layer. Render it as the
 * FIRST child of a `position:relative; overflow:hidden` container
 * (`.cl-group-hero`), with the foreground content in a later sibling
 * (`.cl-group-hero-copy`) so the sibling selectors in group-hero.css can lift
 * the text colour once the picture has actually painted.
 *
 * Privacy: the picture arrives only through `useEncryptedAvatar` (download +
 * client-side AES-256-GCM decrypt, then a blob: URL) and is gated by
 * `safeImageSrc`; there is never a plaintext URL to the server. The blob URL is
 * OWNED by that hook's session cache (shared with every other avatar showing the
 * same attachment), so this component deliberately does not revoke it — doing so
 * would blank the sidebar/header copies. `evictAvatar` handles the bad-bytes case.
 *
 * No layout impact: absolutely positioned, and invisible until loaded, so the
 * no-picture / loading / failed states are exactly the plain card.
 */
export const GroupBackdrop: React.FC<GroupBackdropProps> = ({ attachmentId, token }) => {
    const src = safeImageSrc(useEncryptedAvatar(attachmentId ?? null, token)) ?? null;
    // Keyed by src: a new picture starts "not loaded" again and cross-fades in.
    const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
    const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
    const usable = !!src && brokenSrc !== src;
    const loaded = usable && loadedSrc === src;

    return (
        <div className="cl-group-backdrop" data-testid="group-backdrop" data-loaded={loaded ? 'true' : 'false'} aria-hidden="true">
            {usable && (
                <img
                    className="cl-group-backdrop-img"
                    src={src}
                    alt=""
                    draggable={false}
                    onLoad={() => setLoadedSrc(src)}
                    onError={() => {
                        if (attachmentId && !/^(blob|data):/.test(attachmentId)) evictAvatar(attachmentId);
                        setBrokenSrc(src);
                    }}
                />
            )}
            <div className="cl-group-backdrop-scrim" />
        </div>
    );
};
