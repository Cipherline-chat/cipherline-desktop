/**
 * ChannelDividerRow - draws one channel-list divider (TS3-style section
 * break). Purely visual: no click action for members, nothing to post in.
 *
 * The label is shown EXACTLY as typed: nothing is added around it (no
 * automatic sparkles, no forced capitals). People who want decoration paste it
 * into the label.
 *
 * Label styles (all use the divider's colour, default Glow gold):
 *   label   centred between two fading rules (JetBrains Mono).
 *   header  left-aligned, one rule running to the right edge (section header).
 *   pill    a tinted capsule centred on a rule.
 *   text    tinted text only, centred, no rule.
 * Other styles: line (a hairline), dots (`• • •`), space (blank room). An
 * unknown `style` (a newer client's) draws as `line` rather than nothing.
 *
 * The label is rendered as a text node (never HTML), and the colour is used
 * only after `normalizeDividerColor` accepts it as `#rrggbb` - a malformed
 * value from anywhere falls back to the default instead of reaching a style.
 *
 * `DividerHitArea` is the interactive wrapper the list puts around it.
 */

import React from 'react';
import { EyeOff } from 'lucide-react';
import { DIVIDER_DEFAULT_COLOR, normalizeDividerColor } from '@cipherline/shared';
import type { DividerInfo } from '../../hooks/useServers';

const dividerColor = (d: Pick<DividerInfo, 'color'>): string => normalizeDividerColor(d.color) ?? DIVIDER_DEFAULT_COLOR;

/** `#rrggbb` -> `rgba(r, g, b, a)`. Input is already validated. */
function rgba(hex: string, alpha: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface Props {
    divider: Pick<DividerInfo, 'style' | 'label' | 'color'>;
    /** Compact (style-picker tiles): less vertical padding. */
    compact?: boolean;
}

const MONO = { fontFamily: 'var(--cl-font-mono)', letterSpacing: '0.12em' } as const;
const DISPLAY = { fontFamily: 'var(--cl-font-display)' } as const;

export const ChannelDividerVisual: React.FC<Props> = ({ divider, compact }) => {
    const color = dividerColor(divider);
    const label = divider.label ?? '';
    // Wrapper uses padding (never margin) so the row's own box holds its full
    // height: a child margin would collapse through the wrapper and leave the
    // clickable area a pixel tall.
    const lineRule = `linear-gradient(90deg, transparent, ${rgba(color, 0.55)}, transparent)`;

    switch (divider.style) {
        case 'label':
            return (
                <div className={`flex items-center gap-2.5 select-none ${compact ? 'px-1 py-1' : 'px-2 pt-3.5 pb-1.5'}`} style={{ color }}>
                    <span className="flex-1 h-px min-w-[12px]" style={{ background: lineRule }} aria-hidden="true" />
                    {label && <span className="truncate max-w-[80%] text-[10.5px] font-semibold" style={MONO}>{label}</span>}
                    {label && <span className="flex-1 h-px min-w-[12px]" style={{ background: lineRule }} aria-hidden="true" />}
                </div>
            );
        case 'header':
            return (
                <div className={`flex items-center gap-2 select-none ${compact ? 'px-1 py-1' : 'px-2.5 pt-3 pb-1'}`} style={{ color }}>
                    {label && <span className="truncate max-w-[75%] text-[12px] font-semibold" style={{ ...DISPLAY, transform: 'translateY(0.6px)' }}>{label}</span>}
                    <span className="flex-1 h-px min-w-[12px]" style={{ background: `linear-gradient(90deg, ${rgba(color, 0.6)}, ${rgba(color, 0.08)})` }} aria-hidden="true" />
                </div>
            );
        case 'pill':
            return (
                <div className={`flex items-center gap-2 select-none ${compact ? 'px-1 py-1' : 'px-2 pt-3 pb-1.5'}`} style={{ color }}>
                    <span className="flex-1 h-px min-w-[10px]" style={{ background: rgba(color, 0.35) }} aria-hidden="true" />
                    {label && (
                        <span
                            className="truncate max-w-[78%] text-[10.5px] font-semibold rounded-full px-2.5 py-[2px] border border-solid"
                            style={{ ...MONO, background: rgba(color, 0.14), borderColor: rgba(color, 0.45) }}
                        >
                            {label}
                        </span>
                    )}
                    <span className="flex-1 h-px min-w-[10px]" style={{ background: rgba(color, 0.35) }} aria-hidden="true" />
                </div>
            );
        case 'text':
            return (
                <div className={`text-center select-none ${compact ? 'px-1 py-1.5' : 'px-2 pt-3 pb-1'}`} style={{ color }}>
                    <span className="inline-block truncate max-w-full text-[12px] font-semibold" style={DISPLAY}>{label}</span>
                </div>
            );
        case 'dots':
            return (
                <div
                    className={`text-center text-[10px] text-cl-faint select-none ${compact ? 'py-1' : 'py-1.5'}`}
                    style={{ letterSpacing: '0.6em', paddingLeft: '0.6em' }}
                    aria-hidden="true"
                >
                    • • •
                </div>
            );
        case 'space':
            return <div className={compact ? 'h-6 rounded-[5px] border border-dashed border-cl-border' : 'h-3.5'} />;
        case 'line':
        default:
            return <div className={compact ? 'px-1.5 py-3' : 'px-2.5 py-2.5'}><div className="h-px" style={{ background: 'var(--cl-border)' }} /></div>;
    }
};

/** Smallest height a manager's divider row may have: a comfortable click / right-click / drag target. */
export const DIVIDER_HIT_MIN_PX = 24;

interface HitProps {
    divider: Pick<DividerInfo, 'style' | 'label' | 'color'> & { divider_id?: string };
    /** Managers: the row is clickable, right-clickable and draggable. Members get a plain, inert row. */
    interactive: boolean;
    /** A save is in flight. */
    pending?: boolean;
    /** Genuinely hidden from members (nothing visible next to it): shown with an eye-off mark, never dimmed. */
    hiddenFromMembers?: boolean;
    ariaLabel: string;
    tabIndex?: number;
    onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}

export const HIDDEN_FROM_MEMBERS_TITLE = 'Hidden from members: nothing visible next to it';

/**
 * The row wrapper. For managers it has a `DIVIDER_HIT_MIN_PX` minimum height
 * with the visual centred in it, a hover wash and a grab cursor; the extra
 * height is the row's OWN box (nothing overlaps a neighbouring channel row, so
 * it can neither steal their clicks nor their drops). Members get none of it:
 * no min-height, hover, cursor or focus stop - the visual's own spacing.
 */
export const DividerHitArea: React.FC<HitProps> = ({
    divider, interactive, pending, hiddenFromMembers, ariaLabel, tabIndex, onContextMenu, onDoubleClick, onKeyDown,
}) => (
    <div
        role="separator"
        aria-label={ariaLabel}
        data-divider-id={divider.divider_id}
        data-divider-interactive={interactive ? 'true' : 'false'}
        data-hidden-from-members={hiddenFromMembers ? 'true' : undefined}
        tabIndex={interactive ? tabIndex : undefined}
        className={`relative rounded-[6px] outline-none focus-visible:ring-1 focus-visible:ring-cl-lume/60 ${
            interactive ? 'flex flex-col justify-center min-h-[24px] cursor-grab active:cursor-grabbing hover:bg-cl-lume/[0.07]' : ''
        } ${pending ? 'opacity-60 motion-safe:animate-pulse' : ''}`}
        title={hiddenFromMembers ? HIDDEN_FROM_MEMBERS_TITLE : undefined}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
    >
        <ChannelDividerVisual divider={divider} />
        {hiddenFromMembers && (
            <span
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-cl-faint pointer-events-none"
                role="img"
                aria-label={HIDDEN_FROM_MEMBERS_TITLE}
                data-testid="divider-hidden-mark"
            >
                <EyeOff size={12} />
            </span>
        )}
    </div>
);

export default ChannelDividerVisual;
