import { useEffect, useState } from 'react';

/** Viewport width at which the checkout goes two-column (summary | payment). */
export const CHECKOUT_WIDE_MIN_PX = 860;
export const CHECKOUT_WIDE_QUERY = `(min-width: ${CHECKOUT_WIDE_MIN_PX}px)`;

function readWide(): boolean {
    // No matchMedia (jsdom, SSR): assume the roomy layout.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia(CHECKOUT_WIDE_QUERY).matches;
}

/**
 * True when the window is wide enough for the two-column checkout. Read
 * synchronously on first render (no one-column flash) and kept live, so
 * resizing the window re-flows the open modal.
 *
 * It drives a `data-layout` attribute rather than a CSS-only media query so the
 * DOM itself differs between layouts (the compact summary drops the feature
 * list) and the structure is unit-testable without a layout engine.
 */
export function useCheckoutWide(): boolean {
    const [wide, setWide] = useState<boolean>(readWide);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia(CHECKOUT_WIDE_QUERY);
        const sync = () => setWide(mql.matches);
        sync();
        mql.addEventListener('change', sync);
        return () => mql.removeEventListener('change', sync);
    }, []);
    return wide;
}
