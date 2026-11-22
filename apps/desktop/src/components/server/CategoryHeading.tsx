/**
 * CategoryHeading — the inside of a TOP-LEVEL category's header row, in the
 * text channel list (ServerChannelList) and the Calls panel
 * (ServerContextPanel): chevron, then either the category label or - for a
 * DIVIDER CATEGORY - the divider itself, then the collapsed unread roll-up.
 * The row around it (drag, click / Enter / Space to collapse, aria-expanded,
 * the hover "+" / "..." actions) stays in each panel.
 *
 * HIERARCHY (user request, owner-forwarded 2026-11-17): a top-level category
 * must read as the TOP level - at least as prominent as a sub-category label -
 * while staying clearly different from a channel name. Before, the category
 * was the smallest and faintest text in the list (10px mono semibold,
 * --cl-faint) under bolder sub-category labels (13px display, --cl-muted) and
 * 14px channel names, so a parent category with sub-categories was easy to
 * miss. Now:
 *
 *   category      11.5px mono, UPPERCASE, bold (700), tracked, --cl-muted
 *   sub-category  13px display, medium (500), --cl-muted (faint when collapsed)
 *   channel       14px body, medium, --cl-muted
 *
 * DIVIDER CATEGORY (owner, 2026-11-17): `header_style` set -> the heading is
 * the labelled divider (ChannelDividerVisual: label / header / pill / text,
 * in the divider colour) with a chevron in the same colour. No colour exists
 * on an ordinary category.
 */

import { MutedGlyph } from './muteMenu';
import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CategoryInfo } from '../../hooks/useServers';
import { CATEGORY_LABEL_CLASS, CATEGORY_LABEL_STYLE, categoryDividerLook } from './categoryHeadingStyle';
import { ChannelDividerVisual } from './ChannelDividerRow';
import { ChannelIconRenderer } from './ChannelIconPicker';
import type { UnreadKind } from './offscreenUnread';
import { readableNameColor } from '../../utils/roleColor';

interface Props {
    category: CategoryInfo;
    collapsed: boolean;
    /** Default icon when the category has none (the Calls panel shows Radio); null = none. */
    fallbackIcon?: React.ReactNode;
    /** Size of the category's own icon (the Calls panel draws them larger). */
    iconSize?: number;
    /** Collapsed: the strongest unread kind inside, and a count. */
    rolled?: { kind: UnreadKind; count: number } | null;
    /** The category is muted (utils/channelMute.ts): dim the label, show the muted glyph. */
    muted?: boolean;
}

export const CategoryHeading: React.FC<Props> = ({ category: cat, collapsed, fallbackIcon = null, iconSize = 13, rolled, muted = false }) => {
    const look = categoryDividerLook(cat);
    const Chevron = collapsed ? ChevronRight : ChevronDown;
    const dot = rolled ? (
        <>
            <span
                aria-hidden="true"
                className={`shrink-0 w-[7px] h-[7px] rounded-full ${rolled.kind === 'mention' ? 'bg-cl-flash' : rolled.kind === 'unread' ? 'bg-cl-lume' : 'bg-cl-faint'}`}
            />
            {rolled.count > 0 && (
                <span aria-hidden="true" className="shrink-0 text-[10px] text-cl-faint group-hover:opacity-0 transition-opacity" style={{ fontFamily: 'var(--cl-font-mono)' }}>
                    {rolled.count > 99 ? '99+' : rolled.count}
                </span>
            )}
        </>
    ) : null;

    if (look) {
        return (
            <>
                <span
                    className="shrink-0 w-4 h-4 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity"
                    style={{ color: readableNameColor(look.color) ?? look.color }}
                    data-testid="divider-category-chevron"
                >
                    <Chevron size={16} />
                </span>
                <div className="flex-1 min-w-0" data-divider-category={look.style}>
                    <ChannelDividerVisual compact divider={{ style: look.style, label: cat.name, color: look.color }} />
                </div>
                {muted && <MutedGlyph size={12} />}
                {dot}
            </>
        );
    }
    return (
        <>
            <span className="shrink-0 text-cl-faint group-hover:text-cl-text transition-colors w-4 h-4 flex items-center justify-center">
                <Chevron size={16} />
            </span>
            {cat.icon_name ? (
                <ChannelIconRenderer name={cat.icon_name} size={iconSize} className="shrink-0 block text-cl-muted group-hover:text-cl-text transition-colors" />
            ) : fallbackIcon}
            {/* The TOP level: never quieter than a sub-category label. */}
            <span className={`${CATEGORY_LABEL_CLASS}${muted ? ' opacity-60' : ''}`} style={CATEGORY_LABEL_STYLE}>{cat.name}</span>
            {muted && <MutedGlyph size={12} />}
            {dot}
        </>
    );
};
