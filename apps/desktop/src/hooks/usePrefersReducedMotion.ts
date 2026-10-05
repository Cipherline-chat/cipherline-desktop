import { useEffect, useState } from 'react';

/** Live `prefers-reduced-motion: reduce`. */
export function usePrefersReducedMotion(): boolean {
    const query = '(prefers-reduced-motion: reduce)';
    const [reduced, setReduced] = useState(() => {
        try { return window.matchMedia?.(query).matches ?? false; } catch { return false; }
    });
    useEffect(() => {
        let mql: MediaQueryList | undefined;
        try { mql = window.matchMedia?.(query); } catch { mql = undefined; }
        if (!mql) return;
        const onChange = () => setReduced(mql!.matches);
        mql.addEventListener?.('change', onChange);
        return () => mql!.removeEventListener?.('change', onChange);
    }, []);
    return reduced;
}
