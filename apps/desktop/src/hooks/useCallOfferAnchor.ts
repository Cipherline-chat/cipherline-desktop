/**
 * useCallOfferAnchor — where the in-call offer cards go, measured at runtime.
 *
 * The cards are portalled to <body> (so they survive the call UI re-parenting),
 * which means CSS cannot anchor them to the main content pane. This hook reads
 * the pane's bounding rect and keeps it fresh while a card is open:
 *   - ResizeObserver on the pane (sidebar drag / collapse change its size),
 *   - window resize,
 *   - a slow re-query, because the pane can be swapped out (chat ↔ server
 *     view ↔ Friends/Home remount it) without anything we observe firing.
 * Only active while `enabled` (a card is up), so it costs nothing otherwise.
 *
 * Returns the `{ className, style, held }` for the card's wrapper. When the pane
 * is not found the wrapper falls back to a fixed offset (CALL_OFFER_FALLBACK_CLASS).
 * While an actionable call prompt is open (utils/callNoticeLayer.ts) the card is
 * HELD: off screen, not dismissed, back when the prompt is answered. `held` is
 * returned so the card can keep its sound cue for when it is actually seen.
 */
import { useEffect, useState } from 'react';
import { callOfferPosition, type CallOfferPosition } from '../utils/performanceOffer';
import { callOfferWrapper, type CallOfferWrapper } from '../utils/callNoticeLayer';
import { useCallNoticesHeld } from './useCallNoticeLayer';

/** The main content pane: the chat / channel view, else the full-width
 *  Friends / Home card. Never the sidebar or the rail. */
const ANCHOR_SELECTORS = ['.app-pane3', '.app-pane-solo'];
const RECHECK_MS = 500;

function findAnchor(): HTMLElement | null {
    for (const sel of ANCHOR_SELECTORS) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) return el;
    }
    return null;
}

export function useCallOfferAnchor(enabled: boolean): CallOfferWrapper {
    const [pos, setPos] = useState<CallOfferPosition | null>(null);
    const held = useCallNoticesHeld();

    useEffect(() => {
        if (!enabled) return;
        let observed: HTMLElement | null = null;
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;

        function measure() {
            const el = findAnchor();
            if (el !== observed) {
                if (observed) ro?.unobserve(observed);
                if (el) ro?.observe(el);
                observed = el;
            }
            const next = callOfferPosition(
                el ? el.getBoundingClientRect() : null,
                { width: window.innerWidth, height: window.innerHeight },
            );
            setPos(prev => (prev?.top === next?.top && prev?.left === next?.left ? prev : next));
        }

        measure();
        window.addEventListener('resize', measure);
        const timer = window.setInterval(measure, RECHECK_MS);
        return () => {
            window.removeEventListener('resize', measure);
            window.clearInterval(timer);
            ro?.disconnect();
        };
    }, [enabled]);

    return callOfferWrapper(pos, held);
}
