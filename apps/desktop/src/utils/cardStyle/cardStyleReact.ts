/**
 * The desktop's THIN card-style renderer glue: a validated style plus the
 * effective mode in, inline style + data attributes out. Every decision
 * (validation, clamping, readability, reserved looks, modes) is made in
 * packages/shared/card-style.ts; this file only spells the result as React
 * CSS properties.
 *
 * Sender-agnostic by design: `resolveMessageCard` takes message CONTENT and
 * reads `card_style` through the shared `cardStyleOfContent`, whatever kind
 * of sender produced it. A future bot `app_message` passes its content
 * through the same call and obeys the same server setting, user mode,
 * "Show plain" and server-checked `styled` flag (gateCardStyleByFlag, applied
 * where channel rows are ingested).
 */
import type React from 'react';
import {
    CARD_THEMES, cardStyleOfContent, effectiveCardRenderMode, resolveCardStyle,
    type CardRenderMode, type CardStyle, type CardTheme, type ResolvedCardStyle,
    type ServerMessageStyles, type UserCardStyleMode,
} from '@cipherline/shared';
import { MESSAGE_BODY_LINE_HEIGHT, MESSAGE_BODY_PX } from '../formatting/messageSize';

/**
 * The desktop's theme for card resolution: the chat row background and text
 * colour, and what each theme colour means here — the "glow in the deep"
 * tokens (index.css), which CARD_THEMES.dark mirrors.
 */
export const DESKTOP_CARD_THEME: CardTheme = CARD_THEMES.dark;

/** Everything that decides how a message's card renders for THIS reader. */
export interface CardRenderContext {
    user: UserCardStyleMode;
    /** null in a DM (DMs are unaffected by server settings). */
    server: ServerMessageStyles | null | undefined;
    reducedMotion: boolean;
}

export function cardModeFor(ctx: CardRenderContext, showPlain: boolean): CardRenderMode {
    return effectiveCardRenderMode({ user: ctx.user, server: ctx.server, showPlain, reducedMotion: ctx.reducedMotion });
}

/**
 * The mode for the AUTHOR's live preview in the composer (the box they are
 * typing in while a style is set for the next message). The author chose the
 * style on purpose, so their own "Plain" reading mode doesn't hide it from
 * them; it still decides motion: "Without animation" or "Plain" (as a reader),
 * the server's "No animation" and the OS reduced-motion preference all give a
 * static preview. A server set to Off never gets here (the posting gate offers
 * no style there, so there is nothing to preview).
 */
export function composerCardMode(ctx: CardRenderContext): CardRenderMode {
    const motionOff = ctx.user === 'static' || ctx.user === 'plain';
    return effectiveCardRenderMode({ user: motionOff ? 'static' : ctx.user, server: ctx.server === 'off' ? 'on' : ctx.server, showPlain: false, reducedMotion: ctx.reducedMotion });
}

/** The resolved card for a message's content (any sender kind), or null for plain. */
export function resolveMessageCard(content: unknown, mode: CardRenderMode, theme: CardTheme = DESKTOP_CARD_THEME): ResolvedCardStyle | null {
    return resolveCardStyle(cardStyleOfContent(content), mode, theme);
}

/** Same, for a style object the editor / composer already holds. */
export function resolveCard(style: CardStyle | null | undefined, mode: CardRenderMode, theme: CardTheme = DESKTOP_CARD_THEME): ResolvedCardStyle | null {
    return resolveCardStyle(style ?? null, mode, theme);
}

/** The card element's attributes: the app's class, data-* hooks for message-card.css, and the inline style. */
export type CardElementProps = {
    className: string;
    style: React.CSSProperties;
} & { [K in `data-${string}`]?: string };

/**
 * Everything the card ELEMENT carries, for a resolved style: the one place
 * both the chat row's MessageCard and the composer's live preview get their
 * card from, so the two can't drift. `extraClass` is an app-owned modifier
 * (the editor preview, the swatch, the composer).
 */
export function cardElementProps(r: ResolvedCardStyle, extraClass?: string): CardElementProps {
    return {
        className: extraClass ? `cl-msg-card ${extraClass}` : 'cl-msg-card',
        'data-card-style': '',
        'data-card-anim': r.animation?.name,
        'data-card-stripe': r.stripe ? '' : undefined,
        'data-card-edge': r.edge ? '' : undefined,
        // A text colour other than the app's: links, code, mentions, quotes
        // and spoilers inside derive their colours from it
        // (styles/message-card.css) so they stay readable on the card.
        'data-card-fg': r.textColor ? '' : undefined,
        'data-card-heading-align': r.headingAlign,
        style: cardInlineStyle(r),
    };
}

/** Inline style for the card element. Concrete values only: never a sender string, never var() of an app token. */
export function cardInlineStyle(r: ResolvedCardStyle): React.CSSProperties {
    const [v, h] = r.padding;
    const stripeW = r.stripe?.width ?? 0;
    const style: Record<string, string> = {
        borderRadius: r.radius.map(x => `${x}px`).join(' '),
        padding: `${v}px ${h}px ${v}px ${h + stripeW}px`,
    };
    if (r.backgroundColor) style.backgroundColor = r.backgroundColor;
    if (r.backgroundImage) style.backgroundImage = r.backgroundImage;
    if (r.backgroundClip) { style.backgroundClip = r.backgroundClip; style.backgroundOrigin = r.backgroundClip; }
    if (r.borderWidth) {
        style.borderWidth = r.borderWidth.map(x => `${x}px`).join(' ');
        style.borderStyle = r.borderStyle ?? 'solid';
        style.borderColor = (r.borderColor ?? []).join(' ');
    }
    if (r.boxShadow) {
        style.boxShadow = r.boxShadow;
        style['--cl-card-glow'] = r.boxShadow;
        style['--cl-card-glow-dim'] = r.boxShadowDim ?? r.boxShadow;
    }
    if (r.stripe) {
        style['--cl-card-stripe'] = r.stripe.color;
        style['--cl-card-stripe-w'] = `${r.stripe.width}px`;
    }
    if (r.textColor) style.color = r.textColor;
    if (r.textShadow) style.textShadow = r.textShadow;
    if (r.align) style.textAlign = r.align;
    if (r.letterSpacing !== undefined) style.letterSpacing = `${r.letterSpacing}px`;
    if (r.animation) style['--cl-card-anim-dur'] = `${r.animation.seconds}s`;
    return style as React.CSSProperties;
}

/** The text colour the body should use inside a card (sender's, nudged if needed, or the app's pick), or undefined. */
export function cardTextColor(r: ResolvedCardStyle | null): string | undefined {
    return r?.textColor;
}

/**
 * The editable element's style inside the preview: the row body's text
 * metrics and colour, no padding of its own (the card's padding is the
 * posted card's). Unstyled: `base`, untouched.
 */
export function composerTextStyle(resolved: ResolvedCardStyle | null, base: React.CSSProperties): React.CSSProperties {
    if (!resolved) return base;
    const color = cardTextColor(resolved);
    return {
        ...base,
        // No padding of its own, except 2px reaching into the card's right
        // padding (cancelled by the equal negative margin: same width), so the
        // caret at the end of a line is never clipped by the box's overflow.
        padding: '0 2px 0 0',
        marginRight: -2,
        fontSize: `${MESSAGE_BODY_PX}px`,
        lineHeight: MESSAGE_BODY_LINE_HEIGHT,
        ...(color ? { color } : {}),
    };
}
