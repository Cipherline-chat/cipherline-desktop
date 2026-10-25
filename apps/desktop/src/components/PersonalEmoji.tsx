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
    const inLibrary = useIsInMyEmojis(id);
    const ctx = useContextMenu();
    const { push } = useToast();
    const store = personalEmojis().store;
    const animated = store.meta(id)?.a === 1;

    // Reduced motion: swap an animation for its first frame. The decoded frame
    // is tagged with its id so a stale one is never shown for another emoji.
    const [stillFor, setStillFor] = useState<{ id: string; url: string } | null>(null);
    useEffect(() => {
        if (!reduced || !animated || status !== 'ready') return;
        let live = true;
        void store.read(id).then(bytes => {
            if (!bytes || !live) return;
            void stillFrameUrl(id, bytes, store.meta(id)?.m ?? 'image/webp').then(u => { if (u && live) setStillFor({ id, url: u }); });
        });
        return () => { live = false; };
    }, [reduced, animated, status, id, store]);
    const still = stillFor?.id === id ? stillFor.url : null;

    if (status === 'loading') return <EmojiPlaceholder className={className} style={style} />;
    if (status === 'missing') {
        return <MissingEmojiPlaceholder label={name} noServerContext={noServerContext} className={className} style={style} />;
    }
    return (
        <>
            <img
                src={reduced && animated ? (still ?? undefined) : url}
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
