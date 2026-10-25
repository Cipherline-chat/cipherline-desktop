/**
 * StatusPersonalEmoji - a personal ("My Emojis") emoji in a custom status.
 *
 * DEVICE-ONLY: resolves the image by id from this device's library / received
 * cache and nothing else. The server never holds the image; a friend's client
 * delivers it end to end encrypted (utils/personalEmoji/statusEmoji.ts). If this
 * device does not hold it (not a friend, or not delivered yet) it renders
 * NOTHING - never the raw `cl:` ref, and never a network request. It appears
 * when the delivery lands (the store notifies and the hook re-resolves).
 *
 * Motion: an animated emoji plays only where `animate` is set (the profile
 * card) or while hovered; everywhere else, and always under the OS "reduce
 * motion" setting, it shows its first frame.
 */
import React, { useEffect, useState } from 'react';
import { usePersonalEmojiUrl } from '../hooks/usePersonalEmojis';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { personalEmojis } from '../utils/personalEmoji/service';
import { stillFrameUrl } from '../utils/personalEmoji/stillFrame';

interface Props {
    /** `p_<32 hex>` */
    id: string;
    /** Whose status this is. Unused for resolving (device-only); kept so call sites need no change. */
    userId?: string | null;
    /** Play the animation (profile card). Otherwise first frame unless hovered. */
    animate?: boolean;
    className?: string;
}

export const StatusPersonalEmoji: React.FC<Props> = ({ id, animate = false, className }) => {
    const { status, url } = usePersonalEmojiUrl(id);
    const reduced = usePrefersReducedMotion();
    const [hovered, setHovered] = useState(false);
    const store = personalEmojis().store;
    const animated = store.meta(id)?.a === 1;
    const still = animated && (reduced || !(animate || hovered));

    const [stillFor, setStillFor] = useState<{ id: string; url: string } | null>(null);
    useEffect(() => {
        if (!still || status !== 'ready') return;
        let live = true;
        void store.read(id).then(bytes => {
            if (!bytes || !live) return;
            void stillFrameUrl(id, bytes, store.meta(id)?.m ?? 'image/webp').then(u => { if (u && live) setStillFor({ id, url: u }); });
        });
        return () => { live = false; };
    }, [still, status, id, store]);

    if (status !== 'ready' || !url) return null;
    const src = still ? (stillFor?.id === id ? stillFor.url : undefined) : url;
    if (!src) return null;
    return (
        <img
            src={src}
            alt=""
            aria-hidden="true"
            draggable={false}
            decoding="async"
            className={`inline-block object-contain shrink-0 ${className ?? ''}`}
            style={{ width: '1.25em', height: '1.25em' }}
            onMouseEnter={animated ? () => setHovered(true) : undefined}
            onMouseLeave={animated ? () => setHovered(false) : undefined}
        />
    );
};

export default StatusPersonalEmoji;
