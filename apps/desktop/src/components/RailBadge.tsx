import React from 'react';
import { formatRailBadgeCount, type BadgeState } from '../utils/unreadBadges';
import '../styles/rail-badge.css';

/**
 * The rail's one numeric-badge presentation — a small pill anchored to a
 * tile's top-right corner.
 *
 * Before this existed, the DM/Group rail tiles rendered a count badge inline
 * inside Dashboard's RailTile, while the server rail tile rendered something
 * visually different for the same idea (a bare unread dot, plus a
 * separately-styled mention pill from components/cl's ClPill) — exactly the
 * inconsistency reported from live testing ("servers just show a dot, I want
 * it consistent like DMs"). Both surfaces now render THIS component so they
 * can't drift apart again; see Dashboard.tsx's RailTile and the server rail
 * tile.
 *
 * Deliberately NOT under components/cl/ — that directory is imported
 * directly by apps/website's Vite config (see CLAUDE.md's Architecture map),
 * so a change to a shared primitive there risks the website build. This
 * component has no such reach, so it lives with the rest of Dashboard's
 * rail-only pieces instead.
 */
export const RailBadge: React.FC<{
    /** Resolved by utils/unreadBadges.resolveBadge / dmGroupRailBadges. `null`
     *  draws nothing.
     *
     *  It is a BadgeState, not a number, on purpose: every caller used to pass
     *  `unread + mentions`, which double-counts an @mention (it sets both
     *  counters, and outside a mute the mention count is a subset of the
     *  unread count) — one @mention drew a badge reading 2. Taking the
     *  resolved object means no caller is in a position to do that arithmetic
     *  again. */
    badge: BadgeState | null;
    /** Extra classes for the host tile's own positioning idiom (e.g. the
     *  server tile's Tailwind `z-10 pointer-events-none` on its badge layer).
     *  The pill's own position/size/color come from inline styles below so
     *  every tile renders pixel-identical regardless of what classes it adds. */
    className?: string;
}> = ({ badge, className }) => {
    const text = badge ? formatRailBadgeCount(badge.count) : null;
    if (text === null) return null;

    // @mentions-only: something is here, but you asked not to be pinged, so
    // there is no number to count up at you. A plain grey dot says exactly
    // that much and no more.
    if (badge!.tone === 'quiet') {
        return (
            <span
                key="dot"
                role="img"
                aria-label="Unread"
                className={`cl-rail-badge${className ? ' ' + className : ''}`}
                style={{
                    position: 'absolute', top: 4, right: 4, width: 12, height: 12,
                    borderRadius: 99, background: 'var(--cl-faint)',
                    border: '2px solid var(--cl-abyss)', boxSizing: 'border-box',
                }}
            />
        );
    }

    return (
        <span
            key="pill"
            role="img"
            aria-label={`${text} unread`}
            className={`cl-rail-badge${className ? ' ' + className : ''}`}
            style={{
                position: 'absolute', top: 2, right: 2, minWidth: 17, height: 17,
                padding: '0 4px', borderRadius: 99,
                background: 'var(--cl-flash)', color: 'var(--cl-on-flash)',
                fontSize: 10, fontWeight: 800, lineHeight: 1,
                fontFamily: 'var(--cl-font-body)', display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center',
                // CENTRING lives on the inner number span (styles/rail-badge.css,
                // `.cl-rail-badge-num`). Flex centres a LINE BOX, and a line box
                // is the font's ascent + descent, not the digits. The old fix
                // (1px bottom padding) was measured to 0px on Linux, but that
                // number depends on which font metrics the platform uses:
                // Windows lays Nunito out differently, and the same 1px left the
                // digit visibly off centre there (reported from the Windows test
                // PC). The span now trims its box to cap-height over the
                // baseline (`text-box`, 10px -> 7.05px, measured), so flex
                // centres the digits' own ink on every platform. 17px (odd)
                // keeps the leftover sub-pixel at <=0.33px at 1x/1.5x/2x.
                // Stops the pill changing width as the count ticks 1 -> 11,
                // which reads as a twitch.
                fontVariantNumeric: 'tabular-nums',
                border: '2px solid var(--cl-abyss)', boxSizing: 'border-box',
            }}
        >
            {/* key={text}: remounts on every change so the number bumps. */}
            <span key={text} className="cl-rail-badge-num">{text}</span>
        </span>
    );
};
