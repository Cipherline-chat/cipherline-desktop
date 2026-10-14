import React, { useId } from 'react';

/**
 * Mute-style toggle icons whose slash DRAWS IN, from the brand guide's icon
 * motion: ONE icon per control, not an on-glyph and an off-glyph cross-faded.
 *
 *   <MicIcon off={!micOn} />   <CamIcon off={!camOn} />   <HeadphonesIcon off={deafened} />
 *
 * Structure (the guide's `cl-slash` contract):
 *   - the svg carries `is-muted` when `off`;
 *   - it contains `<path class="cl-slash" pathLength="24" d="m2 2 20 20">`;
 *   - index.css owns the draw: `.cl-slash` is dashed 24/24 and hidden, and
 *     `.is-muted .cl-slash` zeroes the dash offset, so the stroke runs in over
 *     .25s. `pathLength="24"` normalises the dash maths, so the same 24 covers
 *     the line whatever its real length (the diagonal is 28.28 user units).
 *
 * The base glyphs are the intact lucide ones (same 24 viewBox, 2px stroke,
 * round caps/joins). Lucide's own *Off glyphs are redrawn with a gap where
 * the slash crosses, which a single morphing icon cannot do — and laying a
 * bare slash over the intact glyph smears a line across it (the earlier
 * revision noted in index.css). So the glyph sits inside a mask whose cut-out
 * is a wider copy of the slash, dashed by the very same rule: the gap opens
 * exactly as the slash draws, and the end state matches lucide's Off glyph.
 *
 * Reduced motion: index.css turns the transition off, so `off` lands on the
 * finished slash immediately. Nothing here relies on an animation to make the
 * slash visible; it is a plain stroke-dashoffset of 0 under `.is-muted`.
 */

/** The slash, identical to lucide's `m2 2 20 20`. */
export const SLASH_PATH = 'm2 2 20 20';
/** Gap stroke width: the 2px slash plus ~1.5px of clear space each side. */
export const SLASH_GAP_WIDTH = 5;

export interface SlashableIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'ref'> {
    /** True = the slash is drawn (muted / deafened / camera off). */
    off?: boolean;
}

interface BaseProps extends SlashableIconProps {
    /** The intact glyph's shapes (lucide's non-Off icon node). */
    children: React.ReactNode;
}

export const SlashableSvg = ({ off = false, className, children, ...rest }: BaseProps) => {
    // useId() yields ":r1:"-style ids; strip to a plain fragment so url(#id)
    // is unambiguous in every engine.
    const maskId = `cl-slash-mask-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
    const cls = ['cl-slashable', off ? 'is-muted' : '', className ?? ''].filter(Boolean).join(' ');
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={24}
            height={24}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...rest}
            className={cls}
            data-off={off}
        >
            <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={24} height={24}>
                    <rect x={0} y={0} width={24} height={24} fill="#fff" stroke="none" />
                    <path className="cl-slash cl-slash-gap" d={SLASH_PATH} pathLength={24} stroke="#000" strokeWidth={SLASH_GAP_WIDTH} />
                </mask>
            </defs>
            <g mask={`url(#${maskId})`}>{children}</g>
            <path className="cl-slash" d={SLASH_PATH} pathLength={24} />
        </svg>
    );
};

// Glyph geometry below is lucide-react's own icon nodes (mic, video,
// headphones), so the "on" state is pixel-identical to what shipped.

export const MicIcon = (props: SlashableIconProps) => (
    <SlashableSvg {...props}>
        <path d="M12 19v3" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <rect x={9} y={2} width={6} height={13} rx={3} />
    </SlashableSvg>
);

export const CamIcon = (props: SlashableIconProps) => (
    <SlashableSvg {...props}>
        <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
        <rect x={2} y={6} width={14} height={12} rx={2} />
    </SlashableSvg>
);

export const HeadphonesIcon = (props: SlashableIconProps) => (
    <SlashableSvg {...props}>
        <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
    </SlashableSvg>
);
