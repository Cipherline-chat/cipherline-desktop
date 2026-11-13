/**
 * PersonalEmojiImage - renders one personal ("My Emojis") emoji by id.
 *
 * This is the reusable render API (custom status etc.): give it an id from a
 * `<:name:p_...>` token and a size, and it resolves the image from the local
 * encrypted store, shows a placeholder while that loads, and a labelled
 * "unavailable" glyph when this device never received it.
 *
 *   <PersonalEmojiImage id={id} name={name} style={{ width: 22, height: 22 }} />
 *
 * Animated emojis animate in place (the browser pauses a hidden window's
 * animation on its own); with the OS "reduce motion" setting they show their
 * first frame. Right-click offers "Save to My Emojis" unless `saveable={false}`.
 */
import React, { useEffect, useState } from 'react';
import { EmojiPlaceholder, MissingEmojiPlaceholder } from './server/EmojiImage';
import { usePersonalEmojiUrl, useIsInMyEmojis } from '../hooks/usePersonalEmojis';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { useAppInFront } from '../utils/animatedImage';
import { useContextMenu } from '../hooks/useContextMenu';
import { useToast } from '../contexts/ToastContext';
import { personalEmojis } from '../utils/personalEmoji/service';
import { MenuHost } from './primitives/MenuHost';
import { saveToMyEmojisItem } from './personalEmojiSaveItem';
import { stillFrameUrl } from '../utils/personalEmoji/stillFrame';

interface Props {
    id: string;
    name: string;
    className?: string;
    style?: React.CSSProperties;
    /** Offer "Save to My Emojis" on right-click. Default true. */
    saveable?: boolean;
    /** Wording for the unavailable glyph; true in a DM/group (no server). */
    noServerContext?: boolean;
}

export const PersonalEmojiImage: React.FC<Props> = ({ id, name, className, style, saveable = true, noServerContext = true }) => {
    const { status, url } = usePersonalEmojiUrl(id);
    const reduced = usePrefersReducedMotion();
    // Nothing animated plays while Cipherline is not the focused window.
    const inFront = useAppInFront();
    const frozen = reduced || !inFront;
    const inLibrary = useIsInMyEmojis(id);
    const ctx = useContextMenu();
    const { push } = useToast();
    const store = personalEmojis().store;
    const animated = store.meta(id)?.a === 1;

    // Reduced motion: swap an animation for its first frame. The decoded frame
    // is tagged with its id so a stale one is never shown for another emoji.
    const [stillFor, setStillFor] = useState<{ id: string; url: string | null } | null>(null);
    useEffect(() => {
        if (!frozen || !animated || status !== 'ready') return;
        let live = true;
        void store.read(id).then(bytes => {
            if (!live) return;
            if (!bytes) { setStillFor({ id, url: null }); return; }
            void stillFrameUrl(id, bytes, store.meta(id)?.m ?? 'image/webp').then(u => { if (live) setStillFor({ id, url: u }); });
        });
        return () => { live = false; };
    }, [frozen, animated, status, id, store]);
    const stillState = stillFor?.id === id ? stillFor : null;
    // Reduced motion + an animation: the decoded first frame. While that is
    // being decoded show the loading look (an <img> with no src is a blank
    // box); if the frame cannot be decoded, the animation itself is better
    // than a picture that never appears.
    const awaitingStill = reduced && animated && status === 'ready' && !stillState;

    if (status === 'loading' || awaitingStill) return <EmojiPlaceholder className={className} style={style} />;
    if (status === 'missing') {
        return <MissingEmojiPlaceholder label={name} noServerContext={noServerContext} className={className} style={style} />;
    }
    return (
        <>
            <img
                src={frozen && animated ? (stillState?.url ?? url) : url}
                alt={`:${name}:`}
                title={`:${name}:`}
                className={`object-contain ${className ?? ''}`}
                style={style}
                decoding="async"
                draggable={false}
                onContextMenu={saveable ? (e) => {
                    e.stopPropagation();
                    ctx.open(e, [saveToMyEmojisItem(inLibrary, () => store.read(id), name, push)], `:${name}:`);
                } : undefined}
            />
            <MenuHost>{ctx.menu}</MenuHost>
        </>
    );
};

export default PersonalEmojiImage;
