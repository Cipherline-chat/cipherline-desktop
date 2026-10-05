/**
 * AnnotationRequestButton - the viewer's side of Phase 3, living in the same
 * translucent top-right cluster as the streamer's toolbar, on SOMEONE ELSE's
 * focused / fullscreen tile.
 *
 * Four states, all read from the store so the transport drives them:
 *   - can ask     -> "Ask to draw"  (requestAccess -> grant.request goes out)
 *   - asked       -> "Asked..."      (until the owner's grant.list names us,
 *                                    or the request lapses on its own TTL)
 *   - declined    -> "Ask again in 0:42", disabled, counting down. A decline
 *                    is answered, not ignored: it says no AND says when the
 *                    door reopens, rather than leaving a button that looks
 *                    live and quietly does nothing.
 *   - granted     -> nothing here; VideoTile swaps in the AnnotationToolbar
 *
 * Hidden entirely when the local user may not request (no ANNOTATE in this
 * channel) - a control that can only say "no" is noise.
 */
import React, { useEffect, useState } from 'react';
import { PenLine, Hourglass, Clock } from 'lucide-react';
import { annotationStore, useAnnotationStore, selectCooldownUntil } from '../../utils/annotationStore';

export interface AnnotationRequestButtonProps {
    trackKey: string;
}

const btn = 'inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium bg-black/35 backdrop-blur-sm pointer-events-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70';

/** m:ss, floor-free: 1ms left still reads as a second so the label never
 *  shows "0:00" beside a disabled button. */
const countdown = (ms: number): string => {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const AnnotationRequestButton: React.FC<AnnotationRequestButtonProps> = ({ trackKey }) => {
    const canRequest = useAnnotationStore(s => s.canRequest);
    const asked = useAnnotationStore(s => s.outgoing.includes(trackKey));
    // The DEADLINE comes from the store; the clock is read only inside the
    // timer, never during render (a render that reads Date.now() is impure,
    // and a snapshot that moves on every read would spin
    // useSyncExternalStore). The measurement carries the deadline it belongs
    // to, so a stale one from a previous cooldown is never mistaken for this
    // one - and whether we are cooling at all is decided by the store, so the
    // control never flickers back to "Ask to draw" waiting for a tick.
    const cooldownUntil = useAnnotationStore(selectCooldownUntil(trackKey));
    const [measure, setMeasure] = useState<{ until: number; left: number } | null>(null);
    const left = measure && measure.until === cooldownUntil ? measure.left : null;
    const cooling = cooldownUntil > 0 && (left === null || left > 0);

    useEffect(() => {
        if (cooldownUntil <= 0) return;
        const update = () => setMeasure(prev => {
            const now = Math.max(0, cooldownUntil - Date.now());
            // Same value, same object: once it settles on 0 this stops
            // re-rendering even if the store's expiry tick is not running.
            return prev && prev.until === cooldownUntil && prev.left === now ? prev : { until: cooldownUntil, left: now };
        });
        const first = setTimeout(update, 0);
        const every = setInterval(update, 500);
        return () => { clearTimeout(first); clearInterval(every); };
    }, [cooldownUntil]);

    if (!canRequest) return null;

    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    if (asked) {
        return (
            <span className={`${btn} text-white/70`} aria-live="polite" onClick={stop} onPointerDown={stop}>
                <Hourglass size={12} /> Asked to draw
            </span>
        );
    }
    if (cooling) {
        return (
            <span
                className={`${btn} text-white/55`}
                role="status"
                aria-live="polite"
                title="They declined for now. You can ask again when this runs out."
                onClick={stop}
                onPointerDown={stop}
            >
                <Clock size={12} aria-hidden /> {left === null ? 'Ask again shortly' : `Ask again in ${countdown(left)}`}
            </span>
        );
    }
    return (
        <button
            type="button"
            title="Ask to draw on this video"
            onClick={e => { stop(e); annotationStore.requestAccess(trackKey); }}
            onDoubleClick={stop}
            onPointerDown={stop}
            className={`${btn} text-white/85 hover:text-white hover:bg-black/50`}
        >
            <PenLine size={12} /> Ask to draw
        </button>
    );
};
