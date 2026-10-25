import React, {
    createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, X } from 'lucide-react';
import { ClButton } from './ClButton';
import { useClTooltip } from './cl/useClTooltip';
import {
    MAX_VISIBLE_BANNERS, TONE_PRIORITY, liveRegionFor, splitBanners,
    type BannerEntry, type ClBannerTone,
} from './bannerStack';
import '../styles/cl-banner.css';

/**
 * ClBanner: the ONE notice-strip primitive for the desktop app.
 *
 * A calm, slim (~44px), rounded, inset card: dark surface, a thin tone-coloured
 * accent on the left, a tone-coloured glyph in a soft circle, normal-foreground
 * title text with optional muted secondary text, compact actions (one primary,
 * the rest ghost) and a quiet dismiss. Colour comes from the "glow in the deep"
 * tokens only; warning is amber on the glyph and accent, never a filled slab.
 *
 * Accessibility: `role="alert"` (assertive) for the danger tone only; every
 * other tone is `role="status"` (polite). `live="off"` drops both for a banner
 * whose container already announces it. Actions and dismiss are real buttons.
 *
 * Stacking: inside a <ClBannerStack> banners register themselves, the stack
 * orders them by priority and shows the top MAX_VISIBLE_BANNERS, folding the
 * rest behind a "+N more" toggle. Outside a stack a banner simply renders.
 *
 * Narrow widths: the card is a container; below ~720px the actions drop under
 * the text (the dismiss stays top-right), so nothing clips.
 */

export interface ClBannerAction {
    /** Stable key; also emitted as `data-action` on the wrapper (tests, wiring). */
    key: string;
    label?: React.ReactNode;
    onClick?: () => void;
    /** Default: 'primary' for the first action, 'ghost' after (danger tone: 'danger' first). */
    variant?: 'primary' | 'ghost' | 'danger' | 'ok';
    loading?: boolean;
    disabled?: boolean;
    tooltip?: string;
    /** Custom content in this action's slot (a muted note instead of a button). */
    node?: React.ReactNode;
}

export interface ClBannerProps {
    tone: ClBannerTone;
    /** Optional: a banner with only a description shows it as plain body text. */
    title?: React.ReactNode;
    /** Muted secondary text; flows on the title's line when it fits. */
    description?: React.ReactNode;
    /** A glyph element, or `false` for none. Defaults per tone. */
    icon?: React.ReactNode | false;
    actions?: ClBannerAction[];
    onDismiss?: () => void;
    dismissLabel?: string;
    dismissDisabled?: boolean;
    /** Extra rows under the head row (e.g. one row per flagged device). */
    children?: React.ReactNode;
    /** Stack identity (must be unique among live banners). Defaults to a generated id. */
    id?: string;
    /** Higher shows first. Defaults from the tone. */
    priority?: number;
    /** Override the live-region behaviour; 'off' renders no role. */
    live?: 'polite' | 'assertive' | 'off';
    ariaLabel?: string;
    /** Used outside the top-of-app stack (in a pane, on the auth screen): no stack, no outer inset. */
    inline?: boolean;
    className?: string;
    testId?: string;
    /** Extra `data-*` attributes on the root, keys without the `data-` prefix. */
    data?: Record<string, string>;
}

// ── Stack ──────────────────────────────────────────────────────────────────

interface StackContextValue {
    register: (id: string, priority: number) => () => void;
    order: string[];
    visibleCount: number;
    expanded: boolean;
}

const StackContext = createContext<StackContextValue | null>(null);

/** Registers a banner with the surrounding stack and says whether it shows, and where. */
function useStackSlot(id: string, priority: number, enabled: boolean): { hidden: boolean; order: number } {
    const stack = useContext(StackContext);
    const register = enabled ? stack?.register : undefined;
    useLayoutEffect(() => (register ? register(id, priority) : undefined), [register, id, priority]);
    if (!stack || !enabled) return { hidden: false, order: 0 };
    const rank = stack.order.indexOf(id);
    // Not registered yet (first render, before the layout effect has run): show it
    // rather than flash it away; the effect re-renders us before paint.
    if (rank < 0) return { hidden: false, order: 0 };
    return { hidden: rank >= stack.visibleCount, order: rank };
}

export interface ClBannerStackProps {
    children: React.ReactNode;
    max?: number;
    className?: string;
}

/** The top-of-app container. Renders nothing visible while no banner is live. */
export const ClBannerStack: React.FC<ClBannerStackProps> = ({ children, max = MAX_VISIBLE_BANNERS, className }) => {
    const [entries, setEntries] = useState<BannerEntry[]>([]);
    const [expanded, setExpanded] = useState(false);
    const seq = useRef(0);

    const register = useCallback((id: string, priority: number) => {
        const mine = ++seq.current;
        setEntries(es => [...es.filter(e => e.id !== id), { id, priority, seq: mine }]);
        return () => setEntries(es => es.filter(e => !(e.id === id && e.seq === mine)));
    }, []);

    const split = useMemo(() => splitBanners(entries, expanded, max), [entries, expanded, max]);
    const value = useMemo<StackContextValue>(
        () => ({ register, order: split.order, visibleCount: split.visibleCount, expanded }),
        [register, split, expanded],
    );
    const showToggle = split.hiddenCount > 0;

    return (
        <StackContext.Provider value={value}>
            <div className={['cl-banner-stack', className ?? ''].filter(Boolean).join(' ')} data-banner-stack>
                {children}
                {showToggle && (
                    <button
                        type="button"
                        className="cl-banner-more"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(x => !x)}
                    >
                        {expanded ? 'Show less' : `+${split.hiddenCount} more`}
                        {expanded ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                    </button>
                )}
            </div>
        </StackContext.Provider>
    );
};

/** A fixed, centred layer for banners that must show above whatever pane is open (renderer hang, device reset). */
export const ClBannerOverlay: React.FC<{ children: React.ReactNode; testId?: string; live?: 'polite' | 'assertive'; className?: string }> =
    ({ children, testId, live, className }) => (
        <div
            className={['cl-banner-overlay', className ?? ''].filter(Boolean).join(' ')}
            data-testid={testId}
            role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined}
            aria-live={live}
        >
            {children}
        </div>
    );

// ── Pieces ─────────────────────────────────────────────────────────────────

const DEFAULT_ICON: Record<ClBannerTone, React.ReactNode> = {
    info: <Info size={15} />,
    neutral: <Info size={15} />,
    warning: <AlertTriangle size={15} />,
    danger: <AlertCircle size={15} />,
    success: <CheckCircle2 size={15} />,
};

const BannerDismiss: React.FC<{ label: string; disabled?: boolean; onDismiss: () => void }> = ({ label, disabled, onDismiss }) => {
    const { anchorProps, tooltip, describedBy } = useClTooltip(label);
    const { ref, ...handlers } = anchorProps;
    return (
        <>
            <button
                type="button"
                ref={ref as React.Ref<HTMLButtonElement>}
                className="cl-banner__x"
                aria-label={label}
                aria-describedby={describedBy}
                disabled={disabled}
                onClick={onDismiss}
                {...handlers}
            >
                <X size={14} aria-hidden />
            </button>
            {tooltip}
        </>
    );
};

export const ClBanner: React.FC<ClBannerProps> = ({
    tone, title, description, icon, actions, onDismiss, dismissLabel = 'Dismiss', dismissDisabled,
    children, id, priority, live, ariaLabel, inline, className, testId, data,
}) => {
    const autoId = useId();
    const bannerId = id ?? autoId;
    // Inline banners never join the top-of-app stack.
    const slot = useStackSlot(bannerId, priority ?? TONE_PRIORITY[tone], !inline);
    if (slot.hidden) return null;

    const liveMode = live ?? liveRegionFor(tone);
    const role = liveMode === 'off' ? undefined : tone === 'danger' || liveMode === 'assertive' ? 'alert' : 'status';
    const dataAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(data ?? {})) dataAttrs[`data-${k}`] = v;
    const glyph = icon === false ? null : (icon ?? DEFAULT_ICON[tone]);
    const hasActions = (actions?.length ?? 0) > 0;

    return (
        <div
            className={['cl-banner', inline ? 'cl-banner--inline' : '', className ?? ''].filter(Boolean).join(' ')}
            data-banner-tone={tone}
            data-testid={testId}
            role={role}
            aria-live={liveMode === 'off' ? undefined : liveMode}
            aria-label={ariaLabel}
            style={inline ? undefined : { order: slot.order }}
            {...dataAttrs}
        >
            <div className="cl-banner__card">
                {glyph && <span className="cl-banner__icon" aria-hidden>{glyph}</span>}
                <p className="cl-banner__text">
                    {title != null && title !== false && <span className="cl-banner__title">{title}</span>}
                    {description != null && description !== false && (
                        <>{title != null && title !== false ? ' ' : ''}<span className={title != null && title !== false ? 'cl-banner__desc' : 'cl-banner__desc cl-banner__desc--solo'}>{description}</span></>
                    )}
                </p>
                {hasActions && (
                    <div className="cl-banner__actions">
                        {(actions ?? []).map((a, i) => (
                            <span key={a.key} data-action={a.key} className="contents">
                                {a.node ?? (
                                    <ClButton
                                        type="button"
                                        size="sm"
                                        variant={a.variant ?? (i === 0 ? (tone === 'danger' ? 'danger' : 'primary') : 'ghost')}
                                        loading={a.loading}
                                        disabled={a.disabled}
                                        tooltip={a.tooltip}
                                        onClick={a.onClick}
                                    >
                                        {a.label}
                                    </ClButton>
                                )}
                            </span>
                        ))}
                    </div>
                )}
                {onDismiss && (
                    <span data-action="dismiss" className="cl-banner__dismiss">
                        <BannerDismiss label={dismissLabel} disabled={dismissDisabled} onDismiss={onDismiss} />
                    </span>
                )}
                {children != null && children !== false && <div className="cl-banner__extra">{children}</div>}
            </div>
        </div>
    );
};

export default ClBanner;
