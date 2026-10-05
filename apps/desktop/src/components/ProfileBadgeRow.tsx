import React from 'react';
import { resolveProfileBadgeColor, resolveProfileBadgeIcon, sortProfileBadges, type ProfileBadge } from '../utils/profileBadges';
import { useClTooltip } from './cl/useClTooltip';

/**
 * Admin-granted custom profile badges — a row of small colored icon
 * swatches next to a username, each carrying its `label` as a hover/focus
 * tooltip (the owner's stated intent: "a custom icon and a hover tip").
 *
 * Renders `null` for zero badges — no wrapper element, no layout shift on a
 * profile that has none, which is the overwhelming majority today.
 *
 * Icon/colour resolution lives in `utils/profileBadges.ts` and degrades
 * gracefully on its own (unrecognised name → generic glyph / accent tint)
 * — this component never needs to know that happened.
 */
export interface ProfileBadgeRowProps {
    badges: readonly ProfileBadge[] | null | undefined;
    /** `md` — 20px swatch, for the profile modal's identity row (next to
     *  the Pro chip). `sm` — 16px swatch, for a dense list row (friends
     *  list). Defaults to `md`. */
    size?: 'sm' | 'md';
    className?: string;
}

const SWATCH: Record<'sm' | 'md', { box: number; icon: number }> = {
    sm: { box: 16, icon: 10 },
    md: { box: 20, icon: 12 },
};

export const ProfileBadgeRow: React.FC<ProfileBadgeRowProps> = ({ badges, size = 'md', className }) => {
    if (!badges || badges.length === 0) return null;
    const ordered = sortProfileBadges(badges);
    const { box, icon } = SWATCH[size];
    return (
        <span className={`inline-flex items-center gap-1${className ? ` ${className}` : ''}`}>
            {ordered.map((b) => (
                <ProfileBadgeChip key={b.badge_id} badge={b} boxSize={box} iconSize={icon} />
            ))}
        </span>
    );
};

interface ChipProps {
    badge: ProfileBadge;
    boxSize: number;
    iconSize: number;
}

/** One badge glyph. Its own `useClTooltip` instance — a row of up to 8
 *  (`BADGE_MAX_PER_USER` server-side) is a trivial number of extra hooks. */
const ProfileBadgeChip: React.FC<ChipProps> = ({ badge, boxSize, iconSize }) => {
    const tokens = resolveProfileBadgeColor(badge.color);
    const { anchorProps, tooltip, describedBy } = useClTooltip(badge.label);
    const { ref: tipRef, ...tipHandlers } = anchorProps;

    // React.createElement rather than a JSX `<Icon />` tag: `Icon` is a plain
    // lookup result (a fixed component from the static allowlist map, not a
    // component newly *defined* on every render), but a locally-bound
    // capitalized variable used as a JSX tag reads the same either way to a
    // structural lint pass — see `react-hooks/static-components`.
    const iconEl = React.createElement(resolveProfileBadgeIcon(badge.icon), {
        style: { width: iconSize, height: iconSize },
        strokeWidth: 2.25,
        'aria-hidden': 'true',
    });

    return (
        <span
            ref={tipRef as React.Ref<HTMLSpanElement>}
            {...tipHandlers}
            tabIndex={0}
            role="img"
            aria-label={badge.label}
            aria-describedby={describedBy}
            className={`inline-flex items-center justify-center rounded-full border shrink-0 cursor-default ${tokens.bg} ${tokens.border} ${tokens.text}`}
            style={{ width: boxSize, height: boxSize }}
        >
            {iconEl}
            {tooltip}
        </span>
    );
};

export default ProfileBadgeRow;
