/**
 * MessageCard: the box a styled message's BODY sits in.
 *
 * Renders ONLY from a resolved, validated style (utils/cardStyle/
 * cardStyleReact.ts → packages/shared resolveCardStyle). Never receives CSS
 * text, class names or URLs from a sender: its classes and keyframes are the
 * app's own (styles/message-card.css), its inline style is concrete values
 * the shared resolver produced.
 *
 * Containment (styles/message-card.css): `contain: paint`, `isolation:
 * isolate`, `overflow: hidden`, `max-width: 100%`, border-box. It never sets
 * position offsets, z-index, transforms or margins, so it cannot leave its
 * row, cover the hover toolbar (z-index 30, outside the card) or change the
 * row layout. The sender's name / avatar / APP tag / timestamp are siblings
 * ABOVE the card, drawn by the app — a style can't reach them.
 *
 * Shadows: a card with shadows sits in an app-owned FRAME that reserves the
 * shadows' reach (resolver `shadowReach`, capped) inside the message row and
 * clips paint at its edge (`overflow: clip`). So a shadow is always fully
 * inside its own row and can never bleed onto the next (or previous) message.
 * Sideways the frame borrows at most the row's own gutters (12px into the
 * avatar gap, 8px into the right padding), so the card stays exactly where a
 * plain message's text would be.
 *
 * With no style (or in plain mode) it renders its children unchanged, so a
 * plain message's DOM is exactly what it was before this feature.
 */
import React from 'react';
import type { ResolvedCardStyle } from '@cipherline/shared';
import { cardElementProps } from '../../utils/cardStyle/cardStyleReact';
import '../../styles/message-card.css';

/** How far a frame may borrow into the row's gutters (avatar gap / right padding). */
const GUTTER_LEFT = 12;
const GUTTER_RIGHT = 8;

export interface MessageCardProps {
    resolved: ResolvedCardStyle | null;
    children?: React.ReactNode;
    /** Extra app-owned class (e.g. the editor's large preview). */
    className?: string;
}

export const MessageCard: React.FC<MessageCardProps> = ({ resolved, children, className }) => {
    if (!resolved) return <>{children}</>;
    // Class, data-* hooks and inline style come from cardElementProps, which
    // the composer's live preview (ComposerCardSurface) uses too.
    const card = <div {...cardElementProps(resolved, className)}>{children}</div>;
    const reach = resolved.shadowReach;
    // Miniatures (swatches, template tiles) need no frame.
    if (!reach || className) return card;
    const l = Math.min(reach.left, GUTTER_LEFT);
    const r = Math.min(reach.right, GUTTER_RIGHT);
    return (
        <div
            className="cl-msg-card-frame"
            data-card-frame=""
            style={{ padding: `${reach.top}px ${r}px ${reach.bottom}px ${l}px`, marginLeft: -l, marginRight: -r }}
        >
            {card}
        </div>
    );
};

export default MessageCard;
