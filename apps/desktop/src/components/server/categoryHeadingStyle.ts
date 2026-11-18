/**
 * The look of a top-level category heading (see CategoryHeading.tsx for the
 * hierarchy and the divider-category rules). Split from the component so the
 * component file exports components only (React fast refresh).
 */
import type React from 'react';
import { DIVIDER_DEFAULT_COLOR, isLabelDividerStyle, normalizeDividerColor, type DividerStyle } from '@cipherline/shared';
import type { CategoryInfo } from '../../hooks/useServers';

/** Tailwind classes of an ordinary top-level category label. */
export const CATEGORY_LABEL_CLASS =
    'truncate flex-1 text-[11.5px] leading-none font-bold uppercase text-cl-muted group-hover:text-cl-text transition-colors';

/** Inline style of an ordinary top-level category label (font + tracking). */
export const CATEGORY_LABEL_STYLE: React.CSSProperties = { fontFamily: 'var(--cl-font-mono)', letterSpacing: '1.2px' };

/**
 * The manager's hover "+" / "..." on a category or sub-category header row: OUT of the
 * layout (display:none) until the row is hovered or has focus, so the label (or a
 * divider category's divider) gets the whole row width. While they only faded
 * (opacity 0), they kept ~54 px, cutting labels to a few letters in the 200 px
 * channel list of a minimum-size window.
 *
 * KEYBOARD focus shows them (so Tab still reaches them) but plain focus must
 * NOT: the header row is a role=button with tabIndex 0, so a mouse click on it
 * (collapse / expand) leaves it focused, and `group-focus-within` then kept the
 * ~83 px slot open after the pointer left - the divider's right rule stayed
 * short until focus moved elsewhere (owner, 2026-11-18). `:focus-visible` is
 * true for keyboard focus and false for a mouse click. Never animate this
 * (width / flex-basis / max-width): the slot is simply in or out of the layout,
 * so the rules share the row instantly.
 */
export const CATEGORY_HEADER_ACTIONS_CLASS =
    'hidden group-hover:flex group-focus-visible:flex group-has-[:focus-visible]:flex ' +
    'group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 group-focus-visible:pointer-events-auto group-has-[:focus-visible]:pointer-events-auto';

/** The divider look of a category, or null for an ordinary one. */
export function categoryDividerLook(cat: Pick<CategoryInfo, 'header_style' | 'header_color'>): { style: DividerStyle; color: string } | null {
    if (!isLabelDividerStyle(cat.header_style)) return null;
    return { style: cat.header_style as DividerStyle, color: normalizeDividerColor(cat.header_color) ?? DIVIDER_DEFAULT_COLOR };
}
