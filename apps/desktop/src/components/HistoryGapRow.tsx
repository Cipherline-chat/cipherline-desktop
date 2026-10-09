import React, { useEffect, useRef } from 'react';
import { ClButton } from './ClButton';
import type { HistoryGap } from '../utils/channelHistoryCoverage';

/**
 * One hole in a server channel's loaded history, rendered inside the message
 * feed (utils/channelHistoryCoverage.ts).
 *
 *  - `top`     above the oldest loaded row: "load older history". Shows a
 *              spinner while a page loads, otherwise a small button.
 *  - `seam`    between the newest proven page and rows cached from an earlier
 *              session that have not been re-checked yet. Usually nothing is
 *              missing there, so it renders as an invisible sentinel and only
 *              shows a thin spinner while it checks.
 *  - `missing` between two loaded stretches (after a jump to an old message,
 *              or below the newest page after a long absence): messages are
 *              known to be missing, so it says so and offers a button.
 *
 * Every variant fills itself when it scrolls within a screen of the viewport
 * (IntersectionObserver rooted at the feed). The parent keys this component
 * by `gap.key`, which changes whenever a fill moves the gap — so a gap that is
 * still in view after a page lands gets a fresh observer, whose first callback
 * fires immediately and loads the next page. A `stalled` gap (its last fill
 * failed) waits for a click instead of retrying in a loop.
 */
export interface HistoryGapRowProps {
    gap: HistoryGap;
    variant: 'top' | 'seam' | 'missing';
    loading: boolean;
    stalled: boolean;
    rootRef: React.RefObject<HTMLElement | null>;
    /** Visible (auto) or clicked — the parent picks the direction. */
    onFill: (gap: HistoryGap, how: 'auto' | 'click') => void;
}

export const HistoryGapRow: React.FC<HistoryGapRowProps> = ({ gap, variant, loading, stalled, rootRef, onFill }) => {
    const sentinelRef = useRef<HTMLDivElement>(null);
    // The observer callback reads the latest props through this ref (kept
    // current after each commit) instead of being re-created per render.
    const latest = useRef({ gap, loading, stalled, onFill });
    useEffect(() => { latest.current = { gap, loading, stalled, onFill }; });

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver((entries) => {
            const cur = latest.current;
            if (!entries.some(e => e.isIntersecting) || cur.loading || cur.stalled) return;
            cur.onFill(cur.gap, 'auto');
        }, { root: rootRef.current, rootMargin: '600px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, [rootRef]);

    const label = variant === 'missing' ? 'Some messages here aren’t loaded' : 'Load older messages';

    // ONE element for the life of the row (the observer watches it), whatever
    // it currently shows.
    const idleSeam = variant === 'seam' && !loading && !stalled;
    return (
        <div
            ref={sentinelRef}
            data-history-gap={gap.key}
            role={idleSeam ? undefined : 'status'}
            aria-hidden={idleSeam || undefined}
            aria-live={idleSeam ? undefined : 'polite'}
            className="flex items-center justify-center gap-2 select-none"
            style={idleSeam ? { height: 1 } : { padding: variant === 'seam' ? '2px 0' : '8px 0 12px' }}
        >
            {idleSeam ? null : loading ? (
                <>
                    <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-primary rounded-full animate-spin" aria-hidden />
                    <span className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>Loading messages…</span>
                </>
            ) : (
                <>
                    {variant === 'missing' && (
                        <span className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>{label}</span>
                    )}
                    <ClButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onFill(gap, 'click')}
                        style={{ fontSize: 11, borderRadius: 999, padding: '6px 12px' }}
                    >
                        {stalled ? 'Couldn’t load — retry' : (variant === 'missing' ? 'Load' : label)}
                    </ClButton>
                </>
            )}
        </div>
    );
};

export default HistoryGapRow;
