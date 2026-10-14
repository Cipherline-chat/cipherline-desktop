/**
 * useOffscreenUnread — measures where the unread anchors of a scrollable list
 * sit relative to its visible area, and performs the "jump to next unread".
 *
 * DOM contract: every element that can carry an unread has
 * `data-unread-anchor="<model key>"` (see offscreenUnread.ts). The list owner
 * passes the model (what the badges say) and gets back the two pill summaries
 * plus `jump(direction)`.
 *
 * Event-driven, no polling: re-measure on (a) the model changing — an unread
 * arrived, a channel was read, a category was collapsed — (b) the scroller
 * scrolling, rAF-coalesced, and (c) the scroller or its content resizing.
 * Only anchors (rows that HAVE an unread) are measured, so the cost scales
 * with the number of unread channels, not the length of the list; React state
 * is touched only when a pill's content actually changes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    classifyAnchors, planJump, summarize, summaryKey, centeredScrollTop, channelKey,
    type MeasuredAnchor, type ModelEntry, type PillSummary, type ScrollView,
} from './offscreenUnread';

export const PULSE_CLASS = 'cl-unread-pulse';

/** Safety net for engines without `scrollend`: how long a smooth scroll is assumed to be in flight. */
const SMOOTH_SETTLE_MS = 700;

export interface OffscreenUnreadState {
    above: PillSummary | null;
    below: PillSummary | null;
}

const EMPTY: OffscreenUnreadState = { above: null, below: null };

const readView = (el: HTMLElement): ScrollView => ({
    scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
});

/** Flash a row. Restarts cleanly if it is already pulsing (remove → reflow → add). */
export function pulseElement(el: HTMLElement): void {
    el.classList.remove(PULSE_CLASS);
    void el.offsetWidth;
    el.classList.add(PULSE_CLASS);
    el.addEventListener('animationend', () => el.classList.remove(PULSE_CLASS), { once: true });
}

const cssEscape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

export interface UseOffscreenUnreadOptions {
    /** The scrollable element (state, not a ref: it mounts after the loading state). */
    scroller: HTMLElement | null;
    model: Map<string, ModelEntry>;
    reducedMotion: boolean;
    /** Expand a collapsed category (jump target hidden inside it). */
    onExpandCategory: (categoryId: string) => void;
}

export function useOffscreenUnread({ scroller, model, reducedMotion, onExpandCategory }: UseOffscreenUnreadOptions) {
    const [state, setState] = useState<OffscreenUnreadState>(EMPTY);
    const stateKeyRef = useRef('-|-');
    const anchorsRef = useRef<MeasuredAnchor[]>([]);
    const modelRef = useRef(model);
    // Destination of a smooth scroll still in flight, so a second click plans
    // from where the first is GOING, not from the mid-animation offset.
    const inFlightTopRef = useRef<number | null>(null);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // A jump whose target was hidden in a collapsed category: finish it once the expansion has rendered.
    const pendingRevealRef = useRef<string | null>(null);
    const focusedPillRef = useRef<HTMLElement | null>(null);

    const measure = useCallback(() => {
        if (!scroller) {
            anchorsRef.current = [];
            if (stateKeyRef.current !== '-|-') { stateKeyRef.current = '-|-'; setState(EMPTY); }
            return;
        }
        const box = scroller.getBoundingClientRect();
        const anchors: MeasuredAnchor[] = [];
        scroller.querySelectorAll<HTMLElement>('[data-unread-anchor]').forEach(node => {
            const entry = modelRef.current.get(node.dataset.unreadAnchor ?? '');
            if (!entry) return;
            const r = node.getBoundingClientRect();
            anchors.push({ ...entry, center: r.top - box.top + scroller.scrollTop + r.height / 2 });
        });
        anchorsRef.current = anchors;
        const { above, below } = classifyAnchors(anchors, readView(scroller));
        const next: OffscreenUnreadState = { above: summarize(above), below: summarize(below) };
        const key = `${summaryKey(next.above)}|${summaryKey(next.below)}`;
        if (key !== stateKeyRef.current) { stateKeyRef.current = key; setState(next); }
    }, [scroller]);

    const scrollToAnchorElement = useCallback((el: HTMLElement) => {
        if (!scroller) return;
        const box = scroller.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const center = r.top - box.top + scroller.scrollTop + r.height / 2;
        const top = centeredScrollTop(center, readView(scroller));
        scroller.scrollTo({ top, behavior: reducedMotion ? 'instant' : 'smooth' });
        if (!reducedMotion) pulseElement(el);
    }, [scroller, reducedMotion]);

    // (a) model changed → the DOM has just been committed with the new badges.
    // Also completes a jump that had to expand a category first.
    useLayoutEffect(() => {
        modelRef.current = model;
        const pending = pendingRevealRef.current;
        if (pending && scroller) {
            const el = scroller.querySelector<HTMLElement>(`[data-unread-anchor="${cssEscape(pending)}"]`);
            // Not (yet) rendered → leave it pending; a stale one is dropped by the next jump.
            if (el) { pendingRevealRef.current = null; scrollToAnchorElement(el); }
        }
        measure();
    }, [model, measure, scroller, scrollToAnchorElement]);

    // (b) scroll, (c) resize.
    useEffect(() => {
        if (!scroller) return;
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; measure(); });
        };
        const onScrollEnd = () => { inFlightTopRef.current = null; };
        scroller.addEventListener('scroll', schedule, { passive: true });
        scroller.addEventListener('scrollend', onScrollEnd);
        let ro: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(schedule);
            ro.observe(scroller);
            if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
        }
        return () => {
            scroller.removeEventListener('scroll', schedule);
            scroller.removeEventListener('scrollend', onScrollEnd);
            ro?.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [scroller, measure]);

    useEffect(() => () => { if (settleTimerRef.current) clearTimeout(settleTimerRef.current); }, []);

    const jump = useCallback((direction: 'above' | 'below') => {
        if (!scroller) return;
        pendingRevealRef.current = null;
        // A keyboard user who activates the pill may be about to lose it (it
        // unmounts once nothing is left off-screen that way): remember, and hand
        // focus to the list afterwards instead of dropping it to <body>.
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        focusedPillRef.current = active instanceof HTMLElement && active.hasAttribute('data-unread-pill') ? active : null;

        measure();
        const view = readView(scroller);
        if (inFlightTopRef.current !== null) view.scrollTop = inFlightTopRef.current;
        const plan = planJump(anchorsRef.current, view, direction, reducedMotion);
        if (!plan) return;

        const { anchor } = plan;
        if (anchor.expandCategoryId) {
            // Hidden inside a collapsed category: open it, then land on its first unread channel.
            pendingRevealRef.current = channelKey(anchor.channelId);
            onExpandCategory(anchor.expandCategoryId);
            return;
        }
        const el = scroller.querySelector<HTMLElement>(`[data-unread-anchor="${cssEscape(anchor.key)}"]`);
        scroller.scrollTo({ top: plan.scrollTop, behavior: plan.behavior });
        if (plan.behavior === 'smooth') {
            inFlightTopRef.current = plan.scrollTop;
            if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
            settleTimerRef.current = setTimeout(() => { inFlightTopRef.current = null; }, SMOOTH_SETTLE_MS);
            if (el) pulseElement(el);
        } else {
            inFlightTopRef.current = null;
        }
    }, [scroller, measure, reducedMotion, onExpandCategory]);

    // Pill gone after a keyboard activation → focus the list.
    useEffect(() => {
        const pill = focusedPillRef.current;
        if (!pill || !scroller) return;
        if (!pill.isConnected) {
            focusedPillRef.current = null;
            scroller.focus({ preventScroll: true });
        }
    }, [state, scroller]);

    return { ...state, jump };
}
