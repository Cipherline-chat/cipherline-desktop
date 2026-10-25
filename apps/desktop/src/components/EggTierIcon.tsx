import React from 'react';

/**
 * The four "Egg hunter" glyphs — one per tier, climbing down the water column:
 * 1 scallop shell (Tide Pooler) → 2 starfish (Reef Explorer) → 3 diving helmet
 * (Deep Diver) → 4 anglerfish with its lure lit (Abyss Legend).
 *
 * Plain stroke SVG in `currentColor`, same drawing language as the lucide icons
 * the other profile badges use (24px grid, 2px-ish round strokes), so the
 * swatch's colour token tints it exactly like any admin badge. No animation
 * here: the glyph also sits in dense lists, and the toast adds its own
 * (reduced-motion-guarded) entrance.
 */
export interface EggTierIconProps {
    /** 1..4. Anything else renders nothing. */
    tier: number;
    size?: number;
    strokeWidth?: number;
    className?: string;
    style?: React.CSSProperties;
}

const SHELL = (
    <>
        <path d="M12 4C7.6 4 4 7.2 4 11.4c0 1.2.3 2.3.9 3.1h14.2c.6-.8.9-1.9.9-3.1C20 7.2 16.4 4 12 4z" />
        <path d="M12 4v10.5M8.3 5.2l1.5 9.3M15.7 5.2l-1.5 9.3" />
        <path d="M9 18.5h6M10.2 14.5 9.4 18.5M13.8 14.5l.8 4" />
    </>
);

const STARFISH = (
    <>
        <path d="M12 2.8l2.5 5.7 6.2.6-4.7 4.1 1.4 6.1-5.4-3.2-5.4 3.2 1.4-6.1-4.7-4.1 6.2-.6z" />
        <circle cx="12" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="12" cy="6.4" r="0.55" fill="currentColor" stroke="none" />
        <circle cx="8.3" cy="14.3" r="0.55" fill="currentColor" stroke="none" />
        <circle cx="15.7" cy="14.3" r="0.55" fill="currentColor" stroke="none" />
    </>
);

const HELMET = (
    <>
        <circle cx="11.5" cy="10" r="7" />
        <circle cx="11.5" cy="9.6" r="3.3" />
        <path d="M9.9 8.7a2 2 0 0 1 1.4-.9" />
        <rect x="4.6" y="16.2" width="13.8" height="3.2" rx="1.1" />
        <path d="M6.2 19.4 5.2 21.6h12.6l-1-2.2" />
        <path d="M17.6 6.2c2.4-.5 3.6.6 3.6 2.3v3.6" />
        <circle cx="6.9" cy="17.8" r="0.45" fill="currentColor" stroke="none" />
        <circle cx="16.1" cy="17.8" r="0.45" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="2.9" r="0.7" fill="currentColor" stroke="none" />
    </>
);

const ANGLER = (
    <>
        <path d="M2.8 14.4c0-3.5 3.2-6.2 7.3-6.2 3.3 0 6 1.6 7 4.1l4.1-2.4v8l-4.1-2.4c-1 1.9-3.5 3.3-7 3.3-4.1 0-7.3-1.2-7.3-4.4z" />
        <path d="M8.6 8.4C8.6 5 11 3.6 14.4 4.5" />
        <circle cx="15.7" cy="4.9" r="1.45" fill="currentColor" />
        <circle cx="7.1" cy="12.6" r="0.9" fill="currentColor" stroke="none" />
        <path d="M3.9 15.4l1.1 1.5 1.1-1.5 1.1 1.5 1.1-1.5" />
    </>
);

const GLYPHS: Record<number, React.ReactNode> = { 1: SHELL, 2: STARFISH, 3: HELMET, 4: ANGLER };

export const EggTierIcon: React.FC<EggTierIconProps> = ({ tier, size = 14, strokeWidth = 1.8, className, style }) => {
    const glyph = GLYPHS[tier];
    if (!glyph) return null;
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className={className}
            style={style}
            data-egg-tier={tier}
        >
            {glyph}
        </svg>
    );
};

export default EggTierIcon;
