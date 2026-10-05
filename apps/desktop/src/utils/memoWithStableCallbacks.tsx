import React, { useRef } from 'react';

/**
 * `React.memo` for a component whose parent passes fresh inline callbacks on
 * every render.
 *
 * Plain React.memo is useless in that case — `onX={() => …}` is a new function
 * each time, so the props never compare equal and the child re-renders on
 * every parent render anyway. This wrapper hands the child ONE stable proxy
 * per callback prop (created on first sight, never replaced) that always
 * calls the parent's LATEST function, so:
 *   - the child skips re-rendering when only callbacks changed identity, and
 *   - calling a callback can never hit a stale closure (the proxy forwards to
 *     whatever the parent passed on its most recent render).
 *
 * Only for callbacks invoked from events/effects — not render props: a
 * function the child calls DURING render would be called through the proxy
 * with the latest props, which is also correct, but changing its identity no
 * longer triggers a re-render on its own.
 */
export function memoWithStableCallbacks<P extends object>(Component: React.ComponentType<P>): React.FC<P> {
    const Inner = React.memo(Component) as unknown as React.ComponentType<P>;
    const Outer: React.FC<P> = (props) => {
        const latest = useRef(props);
        latest.current = props;
        const proxies = useRef(new Map<string, (...args: unknown[]) => unknown>());
        const next: Record<string, unknown> = {};
        for (const key of Object.keys(props)) {
            const value = (props as Record<string, unknown>)[key];
            if (typeof value !== 'function') { next[key] = value; continue; }
            let proxy = proxies.current.get(key);
            if (!proxy) {
                proxy = (...args: unknown[]) => {
                    const fn = (latest.current as Record<string, unknown>)[key];
                    return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
                };
                proxies.current.set(key, proxy);
            }
            next[key] = proxy;
        }
        return <Inner {...(next as P)} />;
    };
    Outer.displayName = `MemoStable(${Component.displayName || Component.name || 'Component'})`;
    return Outer;
}
