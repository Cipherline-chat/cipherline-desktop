import { useLayoutEffect, useRef, useState } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a bag of arbitrary handler signatures
type AnyFn = (...args: any[]) => unknown;

/**
 * Stable stand-ins for a set of per-render callbacks: each returned function
 * keeps its identity for the component's lifetime and always calls the
 * version from the latest committed render.
 *
 * For handlers inside output that is deliberately NOT re-rendered (ChatPane's
 * memoised message rows): a skipped row keeps the handlers from its last
 * render, and those must not act on that render's stale state. Only for
 * event handlers — calling one during render would see the previous commit.
 */
export function useLiveCallbacks<T extends Record<string, AnyFn | undefined>>(fns: T): { [K in keyof T]-?: NonNullable<T[K]> } {
    const live = useRef(fns);
    useLayoutEffect(() => { live.current = fns; });
    const [stable] = useState(() => {
        const out: Record<string, AnyFn> = {};
        for (const name of Object.keys(fns)) {
            out[name] = (...args: unknown[]) => live.current[name]?.(...args);
        }
        return out as { [K in keyof T]-?: NonNullable<T[K]> };
    });
    return stable;
}
