/**
 * ComposerCardSurface: the composer's LIVE card preview, WYSIWYG.
 *
 * While a card style is set for the next message ("Style this message" →
 * "Use for this message", or editing a styled message), the text you type
 * sits INSIDE the same card the chat row will draw for it: left-aligned in
 * the composer's input area like a message, shrink-wrapping the text and
 * growing as you type up to the width a card can take in the feed (the
 * row's message column), then wrapping. Owner requests 2026-11-18 ("see the
 * style applied in the text box as I am typing"; then "It doesn't match how
 * it would look if I sent it. that's what I want").
 *
 * The SAME card, not a lookalike:
 *  - the card element's class, data-* hooks and inline style come from
 *    `cardElementProps` (what MessageCard spreads), built from the same shared
 *    `resolveCardStyle` output, styled by the same styles/message-card.css:
 *    padding, border (double / gradient / per side), radius, shadow, stripe,
 *    colours, alignment, glow, letter-spacing, animation are identical;
 *  - the text takes the row body's metrics: `composerTextStyle` (utils/cardStyle/cardStyleReact.ts) sets the
 *    editable element to MESSAGE_BODY_PX / MESSAGE_BODY_LINE_HEIGHT
 *    (utils/formatting/messageSize.ts, which ChatPane's row body uses), the
 *    card's text colour, no padding of its own;
 *  - its max width is the row's message column (`columnWidth`,
 *    components/messageCard/messageColumn.ts), clamped to the input area;
 *  - shadows get the room the feed's frame gives them (their full reach),
 *    clipped at the frame, so they never paint over the toolbar or send.
 *
 * Editor comfort: an empty card keeps a minimum width so the caret and the
 * placeholder fit; the editable element keeps its own max-height and scrolls
 * inside the card for long drafts. Toolbar, chip, attach and send are
 * siblings, outside the card. Nothing here reads CSS text or a raw style.
 *
 * STABLE DOM: the two wrapper elements are always rendered, styled or not,
 * so applying or removing a style never remounts the editor (focus, caret
 * and undo history survive). Unstyled, both are plain blocks with no box of
 * their own: the composer looks exactly as it did before this feature.
 */
import React from 'react';
import type { ResolvedCardStyle } from '@cipherline/shared';
import { cardElementProps } from '../../utils/cardStyle/cardStyleReact';
import '../../styles/message-card.css';

/** How far the preview's shadow frame may borrow into the pill's own inner padding / the row gap. */
export const COMPOSER_SHADOW_BORROW = 5;

export interface ComposerCardSurfaceProps {
    /** The resolved style for the next message, or null (no preview). */
    resolved: ResolvedCardStyle | null;
    /** The feed's message-column width (px): the widest a card gets once posted. null = the input area's width. */
    columnWidth?: number | null;
    children?: React.ReactNode;
}

export const ComposerCardSurface: React.FC<ComposerCardSurfaceProps> = ({ resolved, columnWidth, children }) => {
    const reach = resolved?.shadowReach;
    const borrow = (n: number) => Math.min(n, COMPOSER_SHADOW_BORROW);
    const frameStyle: Record<string, string> = {};
    if (reach) {
        frameStyle.padding = `${reach.top}px ${reach.right}px ${reach.bottom}px ${reach.left}px`;
        frameStyle.margin = `${-borrow(reach.top)}px ${-borrow(reach.right)}px ${-borrow(reach.bottom)}px ${-borrow(reach.left)}px`;
    }
    if (resolved && columnWidth && columnWidth > 0) frameStyle['--cl-msg-col-w'] = `${columnWidth}px`;
    const inner = resolved
        ? cardElementProps(resolved, 'cl-msg-card--composer')
        : { className: 'cl-composer-card-plain' };
    return (
        <div
            className="cl-composer-card-frame"
            data-composer-card={resolved ? '' : undefined}
            style={Object.keys(frameStyle).length ? frameStyle as React.CSSProperties : undefined}
        >
            <div {...inner}>{children}</div>
        </div>
    );
};

export default ComposerCardSurface;
